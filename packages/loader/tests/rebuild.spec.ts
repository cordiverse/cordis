import { expect, describe, it, beforeAll, beforeEach } from 'vitest'
import { Context, FiberState } from 'cordis'
import MockLoader, { sleep } from './utils.ts'

declare module 'cordis' {
  interface Context {
    foo: { n: number }
  }
}

describe('Loader: entry rebuild', () => {
  const root = new Context()

  let loader!: MockLoader
  let a!: any
  let b!: any
  let c!: any
  let disposeA: () => any = () => {}

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('settings', (ctx: Context) => {
      ctx.provide('settings', {})
    })
    a = loader.mock('a', () => () => disposeA())
    b = loader.mock('b', () => {})
    c = loader.mock('c', () => {})
  })

  beforeEach(async () => {
    await loader.read([])
    for (const fn of [a, b, c]) fn.mock.resetCalls()
    disposeA = () => {}
    loader.changes = []
  })

  // a file reload replays the options through the group
  const replay = (name: string, inject?: string[]) => loader.root.update([
    { id: 'settings', name: 'settings' },
    { id: 'x', name, inject },
  ])

  it.each([undefined, ['settings']])('rebuilds an active entry when its name changes (inject=%s)', async (inject) => {
    await loader.read([{ id: 'settings', name: 'settings' }, { id: 'x', name: 'a', inject }])
    const previous = loader.store.x.innerFiber!

    await replay('b', inject)
    await loader.await()
    expect(previous.uid).to.equal(null)
    expect(loader.store.x.innerFiber?.state).to.equal(FiberState.ACTIVE)
    expect(a.mock.calls).to.have.length(1)
    expect(b.mock.calls).to.have.length(1)
    expect(loader.store.x.options.disabled).to.be.undefined
    expect(loader.changes.every(change => !change.options?.disabled)).to.be.true
  })

  it.each(['import', 'patch'])('uses the new name when it changes during the %s', async (window) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const original = loader.import
    let stop: (() => void) | undefined
    if (window === 'import') {
      // the old name fails to import, as when the rename fixes a wrong name
      loader.import = async (name: string) => {
        if (name === 'a') {
          entered.resolve()
          await promise
          throw new Error('cannot find module a')
        }
        return original.call(loader, name)
      }
    } else {
      stop = root.on('loader/patch-context', async (entry, next) => {
        if (entry.options.name === 'a') {
          entered.resolve()
          await promise
        }
        await next()
      })
    }
    try {
      const creating = loader.root.update([{ id: 'x', name: 'a' }])
      await entered.promise
      const updating = loader.root.update([{ id: 'x', name: 'b' }])
      resolve()
      await Promise.all([creating, updating])
      await loader.await()
    } finally {
      loader.import = original
      stop?.()
    }
    expect(a.mock.calls).to.have.length(0)
    expect(b.mock.calls).to.have.length(1)
  })

  it.each([undefined, ['settings']])('joins a second rename while the first disposal is pending (inject=%s)', async (inject) => {
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    disposeA = () => {
      entered.resolve()
      return held.promise
    }
    await loader.read([{ id: 'settings', name: 'settings' }, { id: 'x', name: 'a', inject }])

    const first = replay('b', inject)
    await entered.promise
    const second = replay('c', inject)
    held.resolve()
    await Promise.all([first, second])
    await loader.await()
    expect(b.mock.calls).to.have.length(0)
    expect(c.mock.calls).to.have.length(1)
    expect(loader.store.x.innerFiber?.state).to.equal(FiberState.ACTIVE)
  })

  it('applies nothing when the entry is removed during the disposal', async () => {
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    disposeA = () => {
      entered.resolve()
      return held.promise
    }
    await loader.read([{ id: 'settings', name: 'settings' }, { id: 'x', name: 'a', inject: ['settings'] }])
    const entry = loader.store.x

    const renaming = replay('b', ['settings'])
    await entered.promise
    loader.remove('x')
    held.resolve()
    await renaming
    await loader.await()
    await sleep()
    expect(b.mock.calls).to.have.length(0)
    expect(entry.outerFiber).to.be.undefined
    expect(entry.innerFiber?.uid ?? null).to.equal(null)
  })

  it('rebuilds when the plugin renames its own entry', async () => {
    const held = Promise.withResolvers<void>()
    const renaming = loader.mock('renaming', () => {
      void loader.update('x', { name: 'b' } as any)
      return () => held.promise
    })
    void loader.root.update([{ id: 'x', name: 'renaming' }])
    await sleep()
    // the rebuild is a task until the old instance is disposed
    expect(loader.getTasks().length).to.be.greaterThan(0)
    expect(b.mock.calls).to.have.length(0)
    held.resolve()
    await loader.await()
    expect(renaming.mock.calls).to.have.length(1)
    expect(b.mock.calls).to.have.length(1)
    expect(loader.store.x.innerFiber?.state).to.equal(FiberState.ACTIVE)
  })
})

describe('Loader: active entry rebuild (#218)', () => {
  it('starts a pending entry when inject is cleared', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as MockLoader
    const plug = loader.mock('plug', () => {})

    const id = await loader.create({ name: 'plug', inject: ['never'] })
    await sleep()
    const old = loader.store[id]!.outerFiber!
    expect(old.state).to.equal(FiberState.PENDING)
    expect(loader.store[id]!.innerFiber).to.be.undefined
    expect(plug.mock.calls).to.have.length(0)

    loader.changes = []
    await loader.update(id, { inject: null })
    await sleep()

    const next = loader.expectFiber(id)
    expect(next.state).to.equal(FiberState.ACTIVE)
    expect(next).to.not.equal(old)
    expect(old.state).to.equal(FiberState.DISPOSED)
    expect(plug.mock.calls).to.have.length(1)
    expect('inject' in loader.store[id]!.options).to.equal(false)
    expect('disabled' in loader.store[id]!.options).to.equal(false)
    expect(loader.changes.some(change => change.options?.disabled === true)).to.equal(false)
  })

  it('reapplies when inject gains a service that is already provided', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as MockLoader
    root.provide('foo', { n: 1 })
    const reads: Context['foo'][] = []
    let applied = 0
    const plug = loader.mock('plug', (ctx: Context) => {
      if (++applied === 2) reads.push(ctx.foo)
    })

    const id = await loader.create({ name: 'plug' })
    await sleep()
    const old = loader.expectFiber(id)
    expect(old.state).to.equal(FiberState.ACTIVE)
    expect(plug.mock.calls).to.have.length(1)

    await loader.update(id, { inject: ['foo'] })
    await sleep()

    expect(plug.mock.calls).to.have.length(2)
    expect(reads).to.deep.equal([{ n: 1 }])
    expect(old.state).to.equal(FiberState.DISPOSED)
    expect(loader.expectFiber(id)).to.not.equal(old)
    expect('disabled' in loader.store[id]!.options).to.equal(false)
  })

  it('keeps the new outer fiber pending and drops the old listener when inject is missing', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as MockLoader
    const ping = Symbol('rebuild')
    let hits = 0
    loader.mock('plug', (ctx: Context) => {
      ctx.on(ping, () => {
        hits++
      })
    })

    const id = await loader.create({ name: 'plug' })
    await sleep()
    const old = loader.expectFiber(id)
    expect(old.state).to.equal(FiberState.ACTIVE)
    root.emit(ping)
    expect(hits).to.equal(1)

    await loader.update(id, { inject: ['foo'] })
    await sleep()

    expect(old.state).to.equal(FiberState.DISPOSED)
    expect(loader.store[id]!.outerFiber!.state).to.equal(FiberState.PENDING)
    expect(loader.store[id]!.innerFiber!.uid).to.equal(null)
    root.emit(ping)
    expect(hits).to.equal(1)
    expect('disabled' in loader.store[id]!.options).to.equal(false)
  })

  it('joins a second inject update while the first rebuild is disposing', async () => {
    const root = new Context()
    root.provide('foo', { n: 1 })
    root.provide('bar', { n: 2 })
    await root.plugin(MockLoader)
    const loader = root.loader as MockLoader
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let applies = 0
    const plug = loader.mock('plug', () => {
      applies++
      return async () => { await gate }
    })

    const id = await loader.create({ name: 'plug' })
    await sleep()
    expect(applies).to.equal(1)

    const first = loader.update(id, { inject: ['foo'] })
    const second = loader.update(id, { inject: ['bar'] })
    await sleep()
    expect(loader.getTasks().length).to.be.greaterThan(0)
    expect(applies).to.equal(1)

    release()
    await first
    await second
    await sleep()

    expect(applies).to.equal(2)
    expect(loader.store[id]!.options.inject).to.deep.equal(['bar'])
    const active = [...loader.ctx.registry.get(plug)!.fibers].filter(fiber => fiber.state === FiberState.ACTIVE)
    expect(active).to.have.length(1)
    expect(loader.expectFiber(id).state).to.equal(FiberState.ACTIVE)
    expect('disabled' in loader.store[id]!.options).to.equal(false)
  })

  it.each(['import', 'failed import', 'context patch'])('uses the latest name during a pending %s', async (stage) => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as MockLoader
    loader.mock('a', () => {})
    const b = loader.mock('b', () => {})
    const c = loader.mock('c', () => {})
    await loader.read([{ id: 'x', name: 'a' }])

    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const load = loader.import
    loader.import = async (name) => {
      if (name === 'b' && stage !== 'context patch') {
        entered.resolve()
        await gate.promise
        if (stage === 'failed import') throw new Error('superseded import')
      }
      return load.call(loader, name)
    }
    root.on('loader/patch-context', async (entry, next) => {
      await next()
      if (entry.options.name !== 'b' || stage !== 'context patch') return
      entered.resolve()
      await gate.promise
    })

    const first = loader.root.update([{ id: 'x', name: 'b' }])
    await entered.promise
    const second = loader.root.update([{ id: 'x', name: 'c' }])
    expect(loader.getTasks().length).to.be.greaterThan(0)
    gate.resolve()
    await Promise.all([first, second])
    await loader.await()

    expect(loader.store.x!.options.name).to.equal('c')
    expect(b.mock.calls).to.have.length(0)
    expect(c.mock.calls).to.have.length(1)
    expect(loader.store.x!.innerFiber!.runtime!.callback).to.equal(c)
    expect('disabled' in loader.store.x!.options).to.equal(false)
  })

  it('does not apply a fiber removed while rebuild is disposing', async () => {
    const root = new Context()
    root.provide('foo', { n: 1 })
    await root.plugin(MockLoader)
    const loader = root.loader as MockLoader
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let applies = 0
    const plug = loader.mock('plug', () => {
      applies++
      return async () => { await gate }
    })

    const id = await loader.create({ name: 'plug' })
    await sleep()
    const pending = loader.update(id, { inject: ['foo'] })
    await sleep()
    loader.remove(id)
    release()
    await pending
    await sleep()

    expect(applies).to.equal(1)
    expect(loader.store[id]).to.equal(undefined)
    expect(loader.ctx.registry.get(plug)).to.equal(undefined)
  })

  it('keeps a rebuild started during apply until its disposer settles', async () => {
    const root = new Context()
    root.provide('foo', { n: 1 })
    root.provide('bar', { n: 2 })
    root.provide('qux', { n: 3 })
    await root.plugin(MockLoader)
    const loader = root.loader as MockLoader
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let applies = 0
    let id = ''
    const plug = loader.mock('plug', () => {
      const n = ++applies
      if (n === 2) loader.update(id, { inject: ['bar'] })
      return async () => { if (n === 2) await gate }
    })

    id = await loader.create({ name: 'plug' })
    await sleep()
    await loader.update(id, { inject: ['foo'] })
    await sleep()

    expect(loader.getTasks().length).to.be.greaterThan(0)
    let idle = false
    const waiting = loader.await().then(() => { idle = true })
    await sleep()
    expect(idle).to.equal(false)
    expect(applies).to.equal(2)

    const third = loader.update(id, { inject: ['qux'] })
    await sleep()
    expect(applies).to.equal(2)

    release()
    await third
    await waiting
    await sleep()

    expect(applies).to.equal(3)
    expect(loader.store[id]!.options.inject).to.deep.equal(['qux'])
    const active = [...loader.ctx.registry.get(plug)!.fibers].filter(fiber => fiber.state === FiberState.ACTIVE)
    expect(active).to.have.length(1)
    expect('disabled' in loader.store[id]!.options).to.equal(false)
  })
})
