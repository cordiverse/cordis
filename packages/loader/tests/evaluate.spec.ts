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
    expect(worker.mock.calls).to.have.length(0)
  })
})
