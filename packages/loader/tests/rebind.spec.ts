import { expect, describe, it } from 'vitest'
import { Context, FiberState } from 'cordis'
import MockLoader, { sleep } from './utils.ts'

declare module 'cordis' {
  interface Context {
    foo: { n: number }
  }
}

// A name or inject change restarts the fiber. That restart is loader-driven,
// so it must not be recorded as the plugin disposing itself.
describe('Loader: live entry rebind', () => {
  it('activates a pending entry when inject is cleared', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as MockLoader
    const plug = loader.mock('plug', () => {})

    const id = await loader.create({ name: 'plug', inject: ['never'] })
    await sleep()
    const old = loader.expectFiber(id)
    expect(old.state).to.equal(FiberState.PENDING)
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

  it('parks the new fiber and drops the old listener when inject is missing', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as MockLoader
    const ping = Symbol('rebind')
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
    expect(loader.expectFiber(id).state).to.equal(FiberState.PENDING)
    root.emit(ping)
    expect(hits).to.equal(1)
    expect('disabled' in loader.store[id]!.options).to.equal(false)
  })

  it('joins a second inject update while the first rebind is disposing', async () => {
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

  it('does not apply a fiber removed while rebind is disposing', async () => {
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

  it('keeps a rebind started during apply until its disposer settles', async () => {
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
