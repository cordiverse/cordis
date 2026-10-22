import { expect, describe, it, beforeAll, beforeEach } from 'vitest'
import { Context, FiberState } from 'cordis'
import { Entry } from '../src/index.ts'
import MockLoader from './utils.ts'

describe('Loader: entry evaluation scope', () => {
  const root = new Context()

  let loader!: MockLoader
  let worker!: any
  let needy!: any
  let seen: { intercept?: any; inject?: any } = {}

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    loader.mock('settings', (ctx: Context, config: any) => {
      ctx.provide('settings', { ...config })
    })
    loader.mock('env', (ctx: Context, config: any) => {
      ctx.provide('env', { ...config })
    })
    worker = loader.mock('worker', (ctx: Context) => {
      seen = { intercept: ctx[Context.intercept], inject: ctx.fiber.inject }
    })
    needy = Object.assign(loader.mock('needy', () => {}), { inject: ['http'] })
  })

  beforeEach(async () => {
    await loader.read([])
    worker.mock.resetCalls()
    needy.mock.resetCalls()
    seen = {}
  })

  const settings = (config: any) => ({ id: 'settings', name: 'settings', config })

  it('creates no outer fiber for an entry without inject', async () => {
    await loader.read([{ id: 'worker', name: 'worker', disabled: { __jsExpr: 'false' } }])

    const entry = loader.store.worker
    expect(entry.outerFiber).to.be.undefined
    expect(entry.innerFiber?.state).to.equal(FiberState.ACTIVE)
    expect(worker.mock.calls).to.have.length(1)
  })

  it('nests the inner fiber under the outer fiber', async () => {
    await loader.read([settings({}), {
      id: 'worker',
      name: 'worker',
      inject: ['settings'],
    }])

    const entry = loader.store.worker
    expect(entry.innerFiber!.parent.fiber.uid).to.equal(entry.outerFiber!.uid)
    expect(Object.keys(entry.outerFiber!.inject)).to.deep.equal(['settings'])
    expect(Object.keys(entry.innerFiber!.inject)).to.deep.equal([])
    expect(entry.outerFiber!.entry === undefined).to.be.true
    expect(entry.innerFiber!.entry === entry).to.be.true
  })

  it('evaluates disabled with the entry inject', async () => {
    await loader.read([settings({ enabled: false }), {
      id: 'worker',
      name: 'worker',
      inject: ['settings'],
      disabled: { __jsExpr: '!settings.enabled' },
    }])

    const entry = loader.store.worker
    expect(entry.disabled).to.equal(true)
    expect(entry.outerFiber?.state).to.equal(FiberState.ACTIVE)
    expect(entry.innerFiber).to.be.undefined
    expect(worker.mock.calls).to.have.length(0)

    await loader.update('settings', { config: { enabled: true } })
    await loader.await()
    expect(entry.disabled).to.equal(false)
    expect(worker.mock.calls).to.have.length(1)
  })

  it('decides disabled before the plugin dependencies', async () => {
    await loader.read([settings({ enabled: false }), {
      id: 'needy',
      name: 'needy',
      inject: ['settings'],
      disabled: { __jsExpr: '!settings.enabled' },
    }])

    const entry = loader.store.needy
    expect(entry.outerFiber?.state).to.equal(FiberState.ACTIVE)
    expect(entry.innerFiber).to.be.undefined

    await loader.update('settings', { config: { enabled: true } })
    await loader.await()
    expect(entry.innerFiber?.state).to.equal(FiberState.PENDING)
  })

  it('waits for the entry inject while it is missing', async () => {
    await loader.read([{
      id: 'worker',
      name: 'worker',
      inject: ['settings'],
      disabled: { __jsExpr: '!settings.enabled' },
    }])

    const entry = loader.store.worker
    expect(entry.outerFiber?.state).to.equal(FiberState.PENDING)
    expect(entry.disabled).to.equal(true)

    await loader.create(settings({ enabled: true }))
    await loader.await()
    expect(entry.disabled).to.equal(false)
    expect(worker.mock.calls).to.have.length(1)
  })

  it('treats a failing expression as disabled', async () => {
    await loader.read([settings({}), {
      id: 'worker',
      name: 'worker',
      inject: ['settings'],
      disabled: { __jsExpr: 'settings.missing.value' },
    }])

    expect(loader.store.worker.innerFiber).to.be.undefined
    expect(worker.mock.calls).to.have.length(0)
  })

  it('evaluates inject values in the parent scope', async () => {
    const inject = { settings: { namespace: { __jsExpr: 'env.namespace' } } }
    await loader.read([{ id: 'env', name: 'env', config: { namespace: 'ns' } }, settings({}), {
      id: 'group',
      name: '@cordisjs/plugin-group',
      group: true,
      inject: ['env'],
      config: [{ id: 'worker', name: 'worker', inject }],
    }])

    const entry = loader.store.worker
    expect(entry.inject).to.deep.equal({ settings: { namespace: 'ns' } })
    expect(entry.outerFiber!.inject).to.deep.equal({ settings: { namespace: 'ns' } })
    expect(entry.options.inject).to.deep.equal(inject)
    expect(worker.mock.calls).to.have.length(1)
  })

  it('cannot read the entry inject from an inject value', async () => {
    await loader.read([settings({ namespace: 'ns' }), {
      id: 'worker',
      name: 'worker',
      inject: { settings: true, other: { __jsExpr: 'settings.namespace' } },
    }])

    const entry = loader.store.worker
    expect(entry.outerFiber).to.be.undefined
    expect(entry.innerFiber).to.be.undefined
    expect(worker.mock.calls).to.have.length(0)
  })

  it('carries an inject value to a service the plugin declares itself', async () => {
    const own = Object.assign(loader.mock('own', () => {}), { inject: ['settings'] })
    await loader.read([settings({}), {
      id: 'own',
      name: 'own',
      inject: { settings: { namespace: 'ns' } },
    }])

    const entry = loader.store.own
    expect(own.mock.calls).to.have.length(1)
    expect(entry.innerFiber!.inject).to.deep.equal({ settings: { namespace: 'ns' } })
  })

  it('evaluates intercept with the entry inject, for the plugin only', async () => {
    await loader.read([settings({ proxy: 'p1' }), {
      id: 'worker',
      name: 'worker',
      inject: ['settings'],
      intercept: { http: { proxy: { __jsExpr: 'settings.proxy' } } },
    }])

    const entry = loader.store.worker
    expect(seen.intercept.http).to.deep.equal({ proxy: 'p1' })
    expect(entry.outerFiber!.ctx[Context.intercept].http).to.be.undefined
    expect(entry.options.intercept).to.deep.equal({ http: { proxy: { __jsExpr: 'settings.proxy' } } })
  })

  it('updates intercept in place', async () => {
    await loader.read([settings({ proxy: 'p1' }), {
      id: 'worker',
      name: 'worker',
      inject: ['settings'],
      intercept: { http: { proxy: { __jsExpr: 'settings.proxy' } } },
    }])
    const table = seen.intercept

    await loader.update('worker', { intercept: { http: { proxy: { __jsExpr: 'settings.proxy + "!"' } } } })
    expect(table.http).to.deep.equal({ proxy: 'p1!' })
    await loader.update('worker', { intercept: null })
    expect(table.http).to.be.undefined
    expect(worker.mock.calls).to.have.length(1)
  })

  it('keeps the options when a dependency is lost and recovered', async () => {
    await loader.read([settings({ enabled: true }), {
      id: 'worker',
      name: 'worker',
      inject: ['settings'],
      disabled: { __jsExpr: '!settings.enabled' },
    }])
    const entry = loader.store.worker
    const outer = entry.outerFiber
    const inner = entry.innerFiber!

    await loader.remove('settings')
    await loader.await()
    expect(inner.uid).to.equal(null)
    expect(entry.outerFiber).to.equal(outer)
    expect(entry.options.disabled).to.deep.equal({ __jsExpr: '!settings.enabled' })

    await loader.create(settings({ enabled: true }))
    await loader.await()
    expect(entry.innerFiber?.state).to.equal(FiberState.ACTIVE)
    expect(worker.mock.calls).to.have.length(2)
  })

  it('reloads the outer fiber when the verdict changes', async () => {
    await loader.read([settings({ enabled: true }), {
      id: 'worker',
      name: 'worker',
      inject: ['settings'],
      disabled: { __jsExpr: '!settings.enabled' },
    }])
    const entry = loader.store.worker
    const outer = entry.outerFiber

    await loader.update('worker', { disabled: { __jsExpr: 'settings.enabled' } })
    expect(entry.innerFiber!.uid).to.equal(null)
    expect(entry.outerFiber).to.equal(outer)

    // same verdict, no reload
    await loader.update('worker', { disabled: { __jsExpr: '!settings.enabled' } })
    await loader.update('worker', { disabled: { __jsExpr: 'settings.enabled && false' } })
    expect(entry.innerFiber!.uid).to.not.equal(null)
    expect(worker.mock.calls).to.have.length(2)
  })

  it('rebuilds the entry when inject changes', async () => {
    await loader.read([settings({}), { id: 'env', name: 'env' }, {
      id: 'worker',
      name: 'worker',
      inject: ['settings'],
    }])
    const entry = loader.store.worker
    const outer = entry.outerFiber!

    await loader.update('worker', { inject: ['settings', 'env'] })
    await loader.await()
    expect(outer.uid).to.equal(null)
    expect(Object.keys(entry.outerFiber!.inject)).to.deep.equal(['settings', 'env'])

    await loader.update('worker', { inject: null })
    await loader.await()
    expect(entry.outerFiber).to.be.undefined
    expect(Entry.isOuter(entry.innerFiber!.parent.fiber)).to.be.false
    expect(worker.mock.calls).to.have.length(3)
  })

  it('disposes the outer fiber when the plugin disposes itself', async () => {
    await loader.read([settings({}), {
      id: 'worker',
      name: 'worker',
      inject: ['settings'],
    }])
    const entry = loader.store.worker
    const outer = entry.outerFiber!

    await entry.innerFiber!.dispose()
    await loader.await()
    expect(entry.options.disabled).to.equal(true)
    expect(outer.uid).to.equal(null)
    expect(entry.outerFiber).to.be.undefined
  })

  it('disposes both fibers when the entry is removed', async () => {
    await loader.read([settings({}), {
      id: 'worker',
      name: 'worker',
      inject: ['settings'],
    }])
    const entry = loader.store.worker
    const { outerFiber, innerFiber } = entry

    await loader.remove('worker')
    await loader.await()
    expect(outerFiber!.uid).to.equal(null)
    expect(innerFiber!.uid).to.equal(null)
  })

  it('keeps a group structural and passes its verdict to the children', async () => {
    await loader.read([settings({ enabled: false }), {
      id: 'group',
      name: '@cordisjs/plugin-group',
      group: true,
      inject: ['settings'],
      disabled: { __jsExpr: '!settings.enabled' },
      config: [{ id: 'worker', name: 'worker' }],
    }])

    const group = loader.store.group
    expect(group.innerFiber?.state).to.equal(FiberState.ACTIVE)
    expect(loader.store.worker.innerFiber).to.be.undefined

    await loader.update('group', { disabled: { __jsExpr: 'false' } })
    await loader.await()
    expect(loader.store.worker.innerFiber?.state).to.equal(FiberState.ACTIVE)
    expect(group.options.disabled).to.deep.equal({ __jsExpr: 'false' })
  })

  it('keeps the entry isolate without an inject', async () => {
    await loader.read([settings({ enabled: true }), {
      id: 'group',
      name: '@cordisjs/plugin-group',
      group: true,
      inject: ['settings'],
      config: [{
        id: 'worker',
        name: 'worker',
        isolate: { settings: 'other' },
        disabled: { __jsExpr: '!settings.enabled' },
      }],
    }])

    expect(loader.store.worker.disabled).to.equal(true)
    expect(worker.mock.calls).to.have.length(0)
  })

  it('rebuilds without a write-back when inject is added', async () => {
    await loader.read([settings({}), { id: 'worker', name: 'worker' }])
    loader.changes = []

    await loader.update('worker', { inject: ['settings'] })
    await loader.await()
    const entry = loader.store.worker
    expect(entry.options.disabled).to.be.undefined
    expect(loader.changes.every(change => !change.options?.disabled)).to.be.true
    expect(entry.innerFiber?.state).to.equal(FiberState.ACTIVE)
    expect(worker.mock.calls).to.have.length(2)
  })

  it('drops an activation whose dependency is lost during the fetch', async () => {
    await loader.read([settings({})])
    const { promise, resolve } = Promise.withResolvers<void>()
    const fetching = Promise.withResolvers<void>()
    const original = loader.import
    let count = 0
    loader.import = async (name: string) => {
      // the second import is the outer fiber's
      if (name === 'worker' && ++count === 2) {
        fetching.resolve()
        await promise
      }
      return original.call(loader, name)
    }
    try {
      await loader.create({ id: 'worker', name: 'worker', inject: ['settings'] })
      await fetching.promise
      loader.remove('settings')
      resolve()
      await loader.await()
    } finally {
      loader.import = original
    }

    expect(worker.mock.calls).to.have.length(0)
    expect(loader.store.worker.outerFiber?.state).to.equal(FiberState.PENDING)
  })

  it('re-evaluates a failing inject value on refresh', async () => {
    await loader.read([{
      id: 'worker',
      name: 'worker',
      inject: { missing: { __jsExpr: 'doesNotExist.value' } },
    }])
    await loader.store.worker.refresh()
    await loader.await()

    expect(loader.store.worker.innerFiber).to.be.undefined
    expect(loader.store.worker.disabled).to.equal(true)
    expect(worker.mock.calls).to.have.length(0)
  })

  it.each([false, true])('caches the verdict independently of reads and service mutations (group=%s)', async (group) => {
    await loader.read([settings({ enabled: true })])
    let reads = 0
    let enabled = true
    Object.defineProperty(root.get('settings'), 'enabled', {
      get() { reads++; return enabled },
    })
    await loader.create({
      id: 'owner',
      name: group ? '@cordisjs/plugin-group' : 'worker',
      group,
      inject: ['settings'],
      disabled: { __jsExpr: '!settings.enabled' },
      config: group ? [{ id: 'child', name: 'worker' }, { id: 'sibling', name: 'worker' }] : undefined,
    })
    await loader.await()
    const owner = loader.store.owner
    const entry = group ? loader.store.child : owner
    expect(reads).to.equal(1)

    enabled = false
    for (let i = 0; i < 3; i++) expect(entry.disabled).to.equal(false)
    expect(reads).to.equal(1)
    expect(entry.innerFiber?.state).to.equal(FiberState.ACTIVE)

    // an explicit update re-evaluates; the group itself still runs
    await loader.update('owner', { config: owner.options.config })
    await loader.await()
    expect(entry.disabled).to.equal(true)
    expect(entry.innerFiber?.uid).to.equal(null)
    if (group) expect(owner.innerFiber?.state).to.equal(FiberState.ACTIVE)
  })

  it('does not repeat a failing disabled expression when its verdict is read', async () => {
    await loader.read([settings({ attempts: 0 }), {
      id: 'worker',
      name: 'worker',
      inject: ['settings'],
      disabled: { __jsExpr: '(settings.attempts++, settings.missing.value)' },
    }])
    for (let i = 0; i < 3; i++) expect(loader.store.worker.disabled).to.equal(true)
    expect(root.get('settings').attempts).to.equal(1)
  })

  it('evaluates a changed disabled expression once in either direction', async () => {
    await loader.read([settings({ count: 0 }), {
      id: 'worker',
      name: 'worker',
      inject: ['settings'],
      disabled: { __jsExpr: '(settings.count++, false)' },
    }])
    const state = root.get('settings')
    const entry = loader.store.worker
    expect(state.count).to.equal(1)

    // a failing expression disables the plugin and is reported once
    await loader.update('worker', { disabled: { __jsExpr: '(settings.count++, settings.missing.value)' } })
    await loader.await()
    expect(state.count).to.equal(2)
    expect(entry.innerFiber!.uid).to.equal(null)

    await loader.update('worker', { disabled: { __jsExpr: '(settings.count++, false)' } })
    await loader.await()
    expect(state.count).to.equal(3)
    expect(entry.innerFiber?.state).to.equal(FiberState.ACTIVE)
    expect(worker.mock.calls).to.have.length(2)
  })

  it('invalidates the verdict before asynchronous dependency teardown', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let disabledDuringTeardown: boolean | undefined
    loader.mock('held', (ctx: Context) => () => {
      disabledDuringTeardown = ctx.fiber.entry!.disabled
      entered.resolve()
      return release.promise
    })
    await loader.read([settings({ enabled: true }), {
      id: 'held', name: 'held', inject: ['settings'], disabled: { __jsExpr: '!settings.enabled' },
    }])
    const entry = loader.store.held
    const outer = entry.outerFiber
    try {
      loader.remove('settings')
      await entered.promise
      expect(entry.disabled).to.equal(true)
      expect(disabledDuringTeardown).to.equal(true)
      expect(entry.outerFiber).to.equal(outer)
      expect(entry.options.disabled).to.deep.equal({ __jsExpr: '!settings.enabled' })
    } finally {
      release.resolve()
      await loader.await()
    }
    // an update while pending keeps the outer fiber
    await loader.update('held', { config: { value: 1 } })
    expect(entry.outerFiber).to.equal(outer)
    await loader.create(settings({ enabled: true }))
    await loader.await()
    expect(entry.disabled).to.equal(false)
    expect(entry.innerFiber?.state).to.equal(FiberState.ACTIVE)
  })

  it('keeps a disabled group verdict undecided when its dependency disappears', async () => {
    await loader.read([settings({ enabled: false }), {
      id: 'owner', name: '@cordisjs/plugin-group', group: true, inject: ['settings'],
      disabled: { __jsExpr: '!settings.enabled' }, config: [{ id: 'child', name: 'worker' }],
    }])
    const owner = loader.store.owner
    loader.remove('settings')
    await loader.await()
    expect(owner._verdict).to.be.undefined
    expect(owner.disabled).to.equal(false)
    expect(owner.options.disabled).to.deep.equal({ __jsExpr: '!settings.enabled' })
    await loader.create(settings({ enabled: true }))
    await loader.await()
    expect(loader.store.child.disabled).to.equal(false)
    expect(worker.mock.calls).to.have.length(1)
  })

  it.each(['disabled', 'inject'])('re-evaluates %s in the new parent scope after a move', async (field) => {
    const child: any = { id: 'worker', name: 'worker' }
    if (field === 'disabled') {
      child.disabled = { __jsExpr: '!env.enabled' }
    } else {
      child.inject = { settings: { namespace: { __jsExpr: 'env.namespace' } } }
      child.disabled = { __jsExpr: 'false' }
    }
    await loader.read([settings({}), ...['a', 'b'].map(id => ({
      id, name: '@cordisjs/plugin-group', group: true, inject: ['env'], isolate: { env: id },
      config: id === 'a' ? [child] : [],
    })), ...['a', 'b'].map(id => ({
      id: `env-${id}`, name: 'env', isolate: { env: id }, config: { enabled: id === 'a', namespace: id },
    }))])
    const entry = loader.store.worker
    await loader.update('worker', {}, 'b')
    await loader.await()
    if (field === 'disabled') {
      expect(entry.disabled).to.equal(true)
      expect(entry.innerFiber?.uid).to.equal(null)
    } else {
      expect(entry.inject.settings).to.deep.equal({ namespace: 'b' })
      expect(entry.outerFiber?.inject.settings).to.deep.equal({ namespace: 'b' })
      expect(entry.innerFiber?.state).to.equal(FiberState.ACTIVE)
    }
  })

  it('re-evaluates the verdict after changing the entry isolation', async () => {
    await loader.read(['a', 'b'].map(id => ({
      id, name: 'settings', isolate: { settings: id }, config: { enabled: id === 'a' },
    })))
    await loader.create({
      id: 'worker', name: 'worker', inject: ['settings'], isolate: { settings: 'a' },
      disabled: { __jsExpr: '!settings.enabled' },
    })
    await loader.await()
    const entry = loader.store.worker
    expect(entry.disabled).to.equal(false)
    await loader.update('worker', { isolate: { settings: 'b' } })
    await loader.await()
    expect(entry.disabled).to.equal(true)
    expect(entry.innerFiber?.uid).to.equal(null)
    expect(entry.options.disabled).to.deep.equal({ __jsExpr: '!settings.enabled' })
  })

  it.each(['import', 'patch'])('drops entries removed or disabled during %s', async (window) => {
    await loader.read([settings({})])
    const original = loader.import
    try {
      for (const inject of [undefined, ['settings']]) {
        for (const action of ['remove', 'disable']) {
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          let stop: (() => void) | undefined
          if (window === 'import') {
            loader.import = async (name: string) => {
              if (name === 'worker') {
                entered.resolve()
                await release.promise
              }
              return original.call(loader, name)
            }
          } else {
            stop = root.on('loader/patch-context', async (entry, next) => {
              if (entry.options.id === 'worker') {
                entered.resolve()
                await release.promise
              }
              await next()
            })
          }
          const creating = loader.create({ id: 'worker', name: 'worker', inject })
          let entry!: Entry
          try {
            await entered.promise
            entry = loader.store.worker
            if (action === 'remove') loader.remove('worker')
            else await loader.update('worker', { disabled: true })
          } finally {
            release.resolve()
            await creating
            loader.import = original
            stop?.()
          }
          await loader.await()
          expect(entry.outerFiber).to.be.undefined
          expect(entry.innerFiber).to.be.undefined
          expect(worker.mock.calls).to.have.length(0)

          // a dropped init does not block a later create or re-enable
          if (action === 'remove') await loader.create({ id: 'worker', name: 'worker', inject })
          else await loader.update('worker', { disabled: false })
          await loader.await()
          expect(loader.store.worker.innerFiber?.state).to.equal(FiberState.ACTIVE)
          expect(worker.mock.calls).to.have.length(1)
          loader.remove('worker')
          await loader.await()
          worker.mock.resetCalls()
        }
      }
    } finally {
      loader.import = original
    }
  })
})
