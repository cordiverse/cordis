import { Context, FiberState, Service, type Fiber } from '../src'
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

  it('reloads when an implementation is replaced during loading', withTimers(async (root) => {
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
    await expect(fiber.dispose()).rejects.toThrow('test')
    await sleep()
    expect(dispose.mock.calls).to.have.length(1)
    expect(error.mock.calls).to.have.length(0)
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

  it('keeps wrapped fiber state canonical across restart and update', async () => {
    const root = new Context()
    const configs: string[] = []
    const fiber = root.plugin((_ctx, config: { value: string }) => {
      configs.push(config.value)
    }, { value: 'first' })

    await fiber
    await fiber.restart()
    fiber.update({ value: 'second' })
    await fiber

    const canonical = Object.getPrototypeOf(fiber)
    expect(configs).to.deep.equal(['first', 'first', 'second'])
    expect(fiber.state).to.equal(canonical.state)
    expect(fiber.config).to.equal(canonical.config)
    expect(Object.hasOwn(fiber, 'state')).to.be.false
    expect(Object.hasOwn(fiber, 'config')).to.be.false
    expect(Object.hasOwn(fiber, 'inertia')).to.be.false
  })

  it('coalesces an update before initial apply into a new generation', async () => {
    const root = new Context()
    const configs: string[] = []
    const fiber = root.plugin((_ctx, config: { value: string }) => {
      configs.push(config.value)
    }, { value: 'old' })

    fiber.update({ value: 'new' })
    await fiber

    expect(configs).to.deep.equal(['new'])
    expect(fiber.state).to.equal(FiberState.ACTIVE)
  })

  it('fails a restart after cleanup errors and allows a later generation to recover', async () => {
    const root = new Context()
    const configs: string[] = []
    let failCleanup = true
    const fiber = root.plugin((_ctx, config: { value: string }) => {
      configs.push(config.value)
      return () => {
        if (failCleanup) throw new Error('cleanup failed')
      }
    }, { value: 'old' })
    await fiber

    fiber.update({ value: 'blocked' })
    await expect(fiber.await()).rejects.toThrow('cleanup failed')
    expect(fiber.state).to.equal(FiberState.FAILED)
    expect(configs).to.deep.equal(['old'])

    failCleanup = false
    fiber.update({ value: 'recovered' })
    await fiber
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(configs).to.deep.equal(['old', 'recovered'])
  })

  it('does not let a stale execution failure poison the current generation', async () => {
    const root = new Context()
    const errors = mock.fn()
    ;(root.logger as any).error = errors
    const gate = Promise.withResolvers<void>()
    const configs: string[] = []
    const fiber = root.plugin(async (_ctx, config: { value: string }) => {
      configs.push(config.value)
      if (config.value === 'old') {
        await gate.promise
        throw new Error('stale execution')
      }
    }, { value: 'old' })

    while (!configs.length) await Promise.resolve()
    fiber.update({ value: 'new' })
    gate.resolve()
    await fiber

    expect(configs).to.deep.equal(['old', 'new'])
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(errors.mock.calls).to.have.length(1)
  })

  it('does not revive a generation across an availability ABA transition', withTimers(async (root) => {
    let available = true
    const values: number[] = []
    root.reflect.provide('foo', 1, () => available)
    const fiber = root.inject(['foo'], async (ctx) => {
      values.push(ctx.foo)
      await sleep(1000)
      return () => sleep(1000)
    })

    await vi.advanceTimersByTimeAsync(400)
    available = false
    root.reflect.notify(['foo'])
    await vi.advanceTimersByTimeAsync(400)
    available = true
    root.reflect.notify(['foo'])
    await vi.advanceTimersByTimeAsync(400)
    expect(fiber.state).to.equal(FiberState.UNLOADING)

    await vi.advanceTimersByTimeAsync(1000)
    expect(fiber.state).to.equal(FiberState.LOADING)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(values).to.deep.equal([1, 1])
  }))

  it('coalesces duplicate dependency notifications without a transition', async () => {
    const root = new Context()
    root.provide('foo', 1)
    let calls = 0
    const fiber = root.inject(['foo'], () => { calls += 1 })
    await fiber

    root.reflect.notify(['foo'])
    await fiber

    expect(calls).to.equal(1)
    expect(fiber.state).to.equal(FiberState.ACTIVE)
  })

  it('distinguishes provider incarnations without a global counter', async () => {
    const root1 = new Context()
    const root2 = new Context()
    const values1: number[] = []
    const values2: number[] = []
    const dispose1 = root1.provide('foo', 1)
    root2.provide('foo', 10)
    const fiber1 = root1.inject(['foo'], ctx => { values1.push(ctx.foo) })
    const fiber2 = root2.inject(['foo'], ctx => { values2.push(ctx.foo) })
    await Promise.all([fiber1, fiber2])

    await dispose1()
    root1.provide('foo', 2)
    await fiber1

    expect(values1).to.deep.equal([1, 2])
    expect(values2).to.deep.equal([10])
    expect(fiber2.state).to.equal(FiberState.ACTIVE)
  })
})

describe('Fiber publication ownership', () => {
  it('resolves dependencies added during publication before activation', async () => {
    const root = new Context()
    root.provide('late', {})
    let calls = 0
    root.on('internal/plugin', (fiber) => {
      if (fiber.name === 'target' && fiber.uid !== null) fiber.inject.late = {}
    })

    const fiber = await root.plugin({
      name: 'target',
      apply() { calls += 1 },
    })

    expect(calls).to.equal(1)
    expect(fiber.state).to.equal(FiberState.ACTIVE)
  })

  it('rolls back runtime ownership when publication throws', () => {
    const root = new Context()
    const plugin = { name: 'broken-publication', apply() {} }
    root.on('internal/plugin', (fiber) => {
      if (fiber.name === plugin.name && fiber.uid !== null) throw new Error('publication failed')
    })

    expect(() => root.plugin(plugin)).to.throw('publication failed')
    expect(root.registry.has(plugin)).to.be.false
  })

  it('contains disposal observers, finishes cleanup, and rejects disposal', async () => {
    const root = new Context()
    const observed: string[] = []
    root.on('internal/plugin', (fiber) => {
      if (fiber.name === 'observed' && fiber.uid === null) throw new Error('observer failed')
    })
    root.on('internal/plugin', (fiber) => {
      if (fiber.name === 'observed' && fiber.uid === null) observed.push('disposed')
    })
    const fiber = await root.plugin({ name: 'observed', apply() {} })

    await expect(fiber.dispose()).rejects.toThrow('observer failed')
    expect(observed).to.deep.equal(['disposed'])
    expect(fiber.state).to.equal(FiberState.DISPOSED)
  })

  it('settles disposal observers and cleanup together with stable error order', async () => {
    const root = new Context()
    const observerGate = Promise.withResolvers<void>()
    const cleanupGate = Promise.withResolvers<void>()
    const observerError = new Error('observer')
    const cleanupError = new Error('cleanup')
    let observerStarted = false
    let cleanupStarted = false
    root.on('internal/plugin', async (fiber) => {
      if (fiber.name !== 'async-disposal' || fiber.uid !== null) return
      observerStarted = true
      await observerGate.promise
      throw observerError
    })
    const fiber = await root.plugin({
      name: 'async-disposal',
      apply() {
        return async () => {
          cleanupStarted = true
          await cleanupGate.promise
          throw cleanupError
        }
      },
    })

    const disposal = fiber.dispose()
    await Promise.resolve()
    expect(observerStarted).to.be.true
    expect(cleanupStarted).to.be.true

    cleanupGate.resolve()
    observerGate.resolve()
    const error = await disposal.catch(error => error)
    expect(error).to.be.instanceOf(AggregateError)
    expect(error.errors).to.deep.equal([observerError, cleanupError])
    expect(fiber.state).to.equal(FiberState.DISPOSED)
  })

  it('lets parent disposal during publication drain pending child effects', async () => {
    const root = new Context()
    let ownerContext!: Context
    const owner = await root.plugin({
      name: 'owner',
      apply(ctx) { ownerContext = ctx },
    })
    const cleanupGate = Promise.withResolvers<void>()
    const cleanupStarted = Promise.withResolvers<void>()
    let parentDisposal!: Promise<void>
    let childFiber!: Fiber
    let childCalls = 0

    root.on('internal/plugin', (fiber) => {
      if (fiber.name !== 'child' || fiber.uid === null) return
      childFiber = fiber
      fiber.ctx.effect(() => async () => {
        cleanupStarted.resolve()
        await cleanupGate.promise
      })
    })
    root.on('internal/plugin', (fiber) => {
      if (fiber.name === 'child' && fiber.uid !== null) parentDisposal = owner.dispose()
    })

    ownerContext.plugin({
      name: 'child',
      apply() { childCalls += 1 },
    })

    await cleanupStarted.promise
    let settled = false
    void parentDisposal.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).to.be.false

    cleanupGate.resolve()
    await parentDisposal
    expect(childCalls).to.equal(0)
    expect(childFiber.state).to.equal(FiberState.DISPOSED)
  })

  it('makes a loading parent join child cleanup already in progress', async () => {
    const root = new Context()
    const cleanupGate = Promise.withResolvers<void>()
    const cleanupStarted = Promise.withResolvers<void>()
    let ownerFiber!: Fiber
    let ownerDisposal!: Promise<void>
    let childDisposal!: Promise<void>
    let childFiber!: Fiber

    root.on('internal/plugin', (fiber) => {
      if (fiber.name !== 'loading-child' || fiber.uid === null) return
      childFiber = fiber
      fiber.ctx.effect(() => async () => {
        cleanupStarted.resolve()
        await cleanupGate.promise
      })
      ownerDisposal = ownerFiber.dispose()
      childDisposal = fiber.dispose()
    })

    const ownerMount = root.plugin({
      name: 'loading-owner',
      apply(ctx) {
        ownerFiber = ctx.fiber
        ctx.plugin({ name: 'loading-child', apply() {} })
      },
    })

    await cleanupStarted.promise
    let settled = false
    void ownerDisposal.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).to.be.false

    cleanupGate.resolve()
    await Promise.all([ownerDisposal, childDisposal, ownerMount])
    expect(childFiber.state).to.equal(FiberState.DISPOSED)
    expect(ownerFiber.state).to.equal(FiberState.DISPOSED)
  })
})
