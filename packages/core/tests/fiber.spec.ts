import { Context, FiberState, Service } from '../src'
import { expect, describe, it, vi } from 'vitest'
import { mock } from 'node:test'
import { event, sleep, withTimers } from './utils'

describe('Fiber', () => {
  it('inertia lock 1', withTimers(async (root) => {
    const dispose = root.provide('foo', 1)
    const fiber = root.inject(['foo'], async () => {
      await sleep(1000)
      return () => sleep(1000)
    })
    await vi.advanceTimersByTimeAsync(400) // 400
    expect(fiber.state).to.equal(FiberState.LOADING)
    dispose()
    await vi.advanceTimersByTimeAsync(400) // 800
    expect(fiber.state).to.equal(FiberState.LOADING)
    await vi.advanceTimersByTimeAsync(400) // 1200
    expect(fiber.state).to.equal(FiberState.UNLOADING)
    root.provide('foo', 1)
    await vi.advanceTimersByTimeAsync(1000) // 2200
    expect(fiber.state).to.equal(FiberState.LOADING)
    await vi.advanceTimersByTimeAsync(1000) // 3200
    expect(fiber.state).to.equal(FiberState.ACTIVE)
  }))

  it('inertia lock 2', withTimers(async (root) => {
    const dispose = root.provide('foo', 1)
    const values: number[] = []
    const fiber = root.inject(['foo'], async (ctx) => {
      values.push(ctx.foo)
      await sleep(1000)
      return () => sleep(1000)
    })
    await vi.advanceTimersByTimeAsync(400) // 400
    expect(fiber.state).to.equal(FiberState.LOADING)
    dispose()
    await vi.advanceTimersByTimeAsync(400) // 800
    expect(fiber.state).to.equal(FiberState.LOADING)
    root.provide('foo', 2)
    await vi.advanceTimersByTimeAsync(400) // 1200
    expect(fiber.state).to.equal(FiberState.UNLOADING)
    await vi.advanceTimersByTimeAsync(1000) // 2200
    expect(fiber.state).to.equal(FiberState.LOADING)
    await vi.advanceTimersByTimeAsync(1000) // 3200
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(values).to.deep.equal([1, 2])
  }))

  it('inertia lock 3', withTimers(async (root) => {
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
    await vi.advanceTimersByTimeAsync(400) // 400
    expect(fiber.state).to.equal(FiberState.LOADING)
    await vi.runAllTimersAsync() // 1000
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await Promise.all([
      provider.dispose(),
      vi.runAllTimersAsync(), // 2000
    ])
    expect(fiber.state).to.equal(FiberState.PENDING)
  }))

  it('plugin error', async () => {
    const root = new Context()
    const callback = mock.fn()
    const error = mock.fn()
    ;(root.logger as any).error = error
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
    ;(root.logger as any).error = error
    const dispose = mock.fn(() => {
      throw new Error('test')
    })
    const plugin = (ctx: Context) => {
      return dispose
    }

    const fiber = await root.plugin(plugin)
    expect(dispose.mock.calls).to.have.length(0)
    await expect(fiber.dispose()).resolves.toBeUndefined()
    await sleep()
    expect(dispose.mock.calls).to.have.length(1)
    expect(error.mock.calls).to.have.length(1)
  })

  it('update config on wrapped fiber', async () => {
    const root = new Context()
    const callback = mock.fn()

    const fiber = root.plugin(callback, { msg: 'hello' })
    await fiber
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments[1]).to.deep.equal({ msg: 'hello' })

    fiber.update({ msg: 'world' })
    await fiber
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls[1].arguments[1]).to.deep.equal({ msg: 'world' })

    fiber.update({ msg: '!!!' })
    await fiber
    expect(callback.mock.calls).to.have.length(3)
    expect(callback.mock.calls[2].arguments[1]).to.deep.equal({ msg: '!!!' })
  })

  it('restart wrapped fiber', async () => {
    const root = new Context()
    const callback = mock.fn()
    const fiber = root.plugin(callback)

    await fiber
    await fiber.restart()

    expect(callback.mock.calls).to.have.length(2)
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(Object.hasOwn(fiber, 'state')).to.equal(false)
    expect(Object.hasOwn(fiber, 'inertia')).to.equal(false)
  })

  it('update config while injected service reloads', async () => {
    const applied: [number, string][] = []

    class Provider extends Service {
      value: number

      constructor(ctx: Context, config: { value: number }) {
        super(ctx, 'provider')
        this.value = config.value
      }
    }

    const Consumer = {
      inject: ['provider'],
      apply(ctx: Context, config: { mode: string }) {
        applied.push([(ctx as any).provider.value, config.mode])
      },
    }

    const root = new Context()
    const provider = root.plugin(Provider, { value: 1 })
    const consumer = root.plugin(Consumer, { mode: 'old' })

    await provider
    await consumer

    provider.update({ value: 2 })
    consumer.update({ mode: 'new' })

    await Promise.all([provider.await(), consumer.await()])

    const base = Object.getPrototypeOf(consumer)
    expect(applied).to.deep.equal([
      [1, 'old'],
      [2, 'new'],
    ])
    expect(consumer.config).to.equal(base.config)
    expect(consumer.state).to.equal(base.state)
    expect(consumer.state).to.equal(FiberState.ACTIVE)
    expect(Object.hasOwn(consumer, 'config')).to.equal(false)
    expect(Object.hasOwn(consumer, 'state')).to.equal(false)
    expect(Object.hasOwn(consumer, 'inertia')).to.equal(false)
  })

  it('does not commit a loading generation after an epoch ABA transition', async () => {
    const root = new Context()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const applied: number[] = []
    const fiber = root.plugin(async (_ctx, config: { value: number }) => {
      applied.push(config.value)
      if (config.value === 1) {
        started.resolve()
        await release.promise
      }
    }, { value: 1 })

    await started.promise
    fiber.update({ value: 2 })
    release.resolve()
    await fiber

    expect(applied).to.deep.equal([1, 2])
    expect(fiber.config).to.deep.equal({ value: 2 })
    expect(fiber.state).to.equal(FiberState.ACTIVE)
  })

  it('does not let a stale execution failure poison the current generation', async () => {
    const root = new Context()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const applied: number[] = []
    const fiber = root.plugin(async (_ctx, config: { value: number }) => {
      applied.push(config.value)
      if (config.value === 1) {
        started.resolve()
        await release.promise
        throw new Error('stale execution')
      }
    }, { value: 1 })

    await started.promise
    fiber.update({ value: 2 })
    release.resolve()
    await fiber

    expect(applied).to.deep.equal([1, 2])
    expect(fiber.state).to.equal(FiberState.ACTIVE)
  })

  it('clears a failed execution when restart begins a new generation', async () => {
    const root = new Context()
    let shouldFail = true
    const fiber = root.plugin(() => {
      if (shouldFail) throw new Error('plugin error')
    })

    await expect(Promise.resolve(fiber)).rejects.toThrow('plugin error')
    expect(fiber.state).to.equal(FiberState.FAILED)

    shouldFail = false
    await fiber.restart()

    expect(fiber.state).to.equal(FiberState.ACTIVE)
  })
})
