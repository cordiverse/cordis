import { Context, FiberState, Service } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'
import { event, sleep, withTimers } from './utils'

describe('Fiber', () => {
  it('inertia lock 1', withTimers(async (root, clock) => {
    const dispose = root.provide('foo', 1)
    const fiber = root.inject(['foo'], async () => {
      await sleep(1000)
      return () => sleep(1000)
    })
    await clock.tickAsync(400) // 400
    expect(fiber.state).to.equal(FiberState.LOADING)
    dispose()
    await clock.tickAsync(400) // 800
    expect(fiber.state).to.equal(FiberState.LOADING)
    await clock.tickAsync(400) // 1200
    expect(fiber.state).to.equal(FiberState.UNLOADING)
    root.provide('foo', 1)
    await clock.tickAsync(1000) // 2200
    expect(fiber.state).to.equal(FiberState.LOADING)
    await clock.tickAsync(1000) // 3200
    expect(fiber.state).to.equal(FiberState.ACTIVE)
  }))

  it('inertia lock 2', withTimers(async (root, clock) => {
    const dispose = root.provide('foo', 1)
    const fiber = root.inject(['foo'], async () => {
      await sleep(1000)
      return () => sleep(1000)
    })
    await clock.tickAsync(400) // 400
    expect(fiber.state).to.equal(FiberState.LOADING)
    dispose()
    await clock.tickAsync(400) // 800
    expect(fiber.state).to.equal(FiberState.LOADING)
    root.provide('foo', 2)
    await clock.tickAsync(400) // 1200
    expect(fiber.state).to.equal(FiberState.ACTIVE)
  }))

  it('inertia lock 3', withTimers(async (root, clock) => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }
    }
    const provider = await root.plugin(Foo)
    const fiber = root.inject(['foo'], async () => {
      await sleep(1000)
      return () => sleep(1000)
    })
    await clock.tickAsync(400) // 400
    expect(fiber.state).to.equal(FiberState.LOADING)
    await clock.runAllAsync() // 1000
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await Promise.all([
      provider.dispose(),
      clock.runAllAsync(), // 2000
    ])
    expect(fiber.state).to.equal(FiberState.PENDING)
  }))

  it('plugin error', async () => {
    const root = new Context()
    const callback = mock.fn()
    const error = mock.fn()
    root.on('internal/error', error)
    const apply = mock.fn((ctx: Context, config: { foo?: boolean } | undefined) => {
      ctx.on(event, callback)
      if (!config?.foo) throw new Error('plugin error')
    })

    const fiber1 = root.plugin(apply)
    const fiber2 = root.plugin(apply, { foo: true })
    await sleep()
    expect(fiber1.state).to.equal(FiberState.FAILED)
    expect(fiber2.state).to.equal(FiberState.ACTIVE)
    // expect(apply.mock.calls).to.have.length(2)
    expect(error.mock.calls).to.have.length(1)

    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('dispose error', async () => {
    const root = new Context()
    const error = mock.fn()
    root.on('internal/error', error)
    const dispose = mock.fn(() => {
      throw new Error('test')
    })
    const plugin = (ctx: Context) => {
      return dispose
    }

    const fiber = await root.plugin(plugin)
    expect(dispose.mock.calls).to.have.length(0)
    await expect(fiber.dispose()).to.be.fulfilled
    await sleep()
    expect(dispose.mock.calls).to.have.length(1)
    expect(error.mock.calls).to.have.length(1)
  })
})
