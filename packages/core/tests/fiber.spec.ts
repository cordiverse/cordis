import { Context, FiberState, Service, ValidationError, type Fiber } from '../src'
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

  it('keeps plugin execution failure separate from rollback cleanup failure', async () => {
    const root = new Context()
    const logged: unknown[] = []
    ;(root.logger as any).error = (error: unknown) => { logged.push(error) }
    const executionError = new Error('execution failed')
    const cleanupError = new Error('cleanup failed')
    const fiber = root.plugin((ctx) => {
      ctx.effect(() => () => { throw cleanupError })
      throw executionError
    })

    const error = await fiber.await().catch(error => error)
    expect(error).to.equal(executionError)
    expect(logged).to.deep.equal([executionError, cleanupError])
    expect(fiber.state).to.equal(FiberState.FAILED)
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
    expect(error.mock.calls[0].arguments[0]).to.have.property('message', 'test')
  })

  it('update config on wrapped fiber', async () => {
    const root = new Context()
    const callback = mock.fn()

    const fiber = root.plugin(callback, { msg: 'hello' })
    await fiber
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments[1]).to.deep.equal({ msg: 'hello' })

    await fiber.update({ msg: 'world' })
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls[1].arguments[1]).to.deep.equal({ msg: 'world' })

    await fiber.update({ msg: '!!!' })
    expect(callback.mock.calls).to.have.length(3)
    expect(callback.mock.calls[2].arguments[1]).to.deep.equal({ msg: '!!!' })
  })

  it('returns the asynchronous internal/update waterfall result', async () => {
    const root = new Context()
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const configs: string[] = []
    const fiber = root.plugin((_ctx, config: { value: string }) => {
      configs.push(config.value)
    }, { value: 'old' })
    await fiber

    fiber.ctx.on('internal/update', async (_config, _noSave, next) => {
      started.resolve()
      await gate.promise
      return next()
    })
    const update = fiber.update({ value: 'new' })
    await started.promise

    let settled = false
    void Promise.resolve(update).then(() => { settled = true })
    await fiber.await()
    expect(settled).to.be.false
    expect(configs).to.deep.equal(['old'])

    gate.resolve()
    await update
    expect(configs).to.deep.equal(['old', 'new'])
  })

  it('keeps wrapped fiber state canonical across restart and update', async () => {
    const root = new Context()
    const configs: string[] = []
    const fiber = root.plugin((_ctx, config: { value: string }) => {
      configs.push(config.value)
    }, { value: 'first' })

    await fiber
    await fiber.restart()
    await fiber.update({ value: 'second' })

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

    await fiber.update({ value: 'new' })

    expect(configs).to.deep.equal(['new'])
    expect(fiber.state).to.equal(FiberState.ACTIVE)
  })

  it('does not clear config validation failure when dependencies become available', async () => {
    const root = new Context()
    const configs: any[] = []
    const Config = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate(config: any) {
          return typeof config?.value === 'string'
            ? { value: config }
            : { issues: [{ message: 'value is required' }] }
        },
      },
    } as any
    const fiber = root.plugin({
      inject: ['ready'],
      Config,
      apply(_ctx, config) { configs.push(config) },
    }, {})

    root.provide('ready', true)
    await expect(Promise.resolve(fiber)).rejects.toBeInstanceOf(ValidationError)
    expect(fiber.state).to.equal(FiberState.FAILED)
    expect(configs).to.deep.equal([])

    await fiber.update({ value: 'valid' })
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(configs).to.deep.equal([{ value: 'valid' }])
  })

  it('clears config validation failure after a valid update while dependencies remain unavailable', async () => {
    const root = new Context()
    const configs: any[] = []
    const Config = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate(config: any) {
          return typeof config?.value === 'string'
            ? { value: config }
            : { issues: [{ message: 'value is required' }] }
        },
      },
    } as any
    const fiber = root.plugin({
      inject: ['ready'],
      Config,
      apply(_ctx, config) { configs.push(config) },
    }, {})

    await expect(Promise.resolve(fiber)).rejects.toBeInstanceOf(ValidationError)
    await fiber.update({ value: 'valid' })
    expect(fiber.state).to.equal(FiberState.PENDING)
    expect(configs).to.deep.equal([])

    root.provide('ready', true)
    await fiber
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(configs).to.deep.equal([{ value: 'valid' }])
  })

  it('continues the next generation after cleanup errors', async () => {
    const root = new Context()
    const configs: string[] = []
    const logged: unknown[] = []
    ;(root.logger as any).error = (error: unknown) => { logged.push(error) }
    const cleanupError = new Error('cleanup failed')
    let failCleanup = true
    const fiber = root.plugin((_ctx, config: { value: string }) => {
      configs.push(config.value)
      return () => {
        if (failCleanup) throw cleanupError
      }
    }, { value: 'old' })
    await fiber

    await fiber.update({ value: 'blocked' })
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(configs).to.deep.equal(['old', 'blocked'])
    expect(logged).to.deep.equal([cleanupError])

    failCleanup = false
    await fiber.update({ value: 'recovered' })
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(configs).to.deep.equal(['old', 'blocked', 'recovered'])
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
    const update = fiber.update({ value: 'new' })
    gate.resolve()
    await update

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

  it('logs disposal observer failures without rejecting disposal', async () => {
    const root = new Context()
    const errors = mock.fn()
    ;(root.logger as any).error = errors
    const observed: string[] = []
    root.on('internal/plugin', (fiber) => {
      if (fiber.name === 'observed' && fiber.uid === null) throw new Error('observer failed')
    })
    root.on('internal/plugin', (fiber) => {
      if (fiber.name === 'observed' && fiber.uid === null) observed.push('disposed')
    })
    const fiber = await root.plugin({ name: 'observed', apply() {} })

    await expect(fiber.dispose()).resolves.toBeUndefined()
    expect(observed).to.deep.equal(['disposed'])
    expect(errors.mock.calls).to.have.length(1)
    expect(errors.mock.calls[0].arguments[0]).to.have.property('message', 'observer failed')
    expect(fiber.state).to.equal(FiberState.DISPOSED)
  })

  it('does not await async disposal observers but still observes rejections', async () => {
    const root = new Context()
    const observerGate = Promise.withResolvers<void>()
    const observerLogged = Promise.withResolvers<void>()
    const cleanupGate = Promise.withResolvers<void>()
    const observerError = new Error('observer')
    const cleanupError = new Error('cleanup')
    const logged: unknown[] = []
    ;(root.logger as any).error = (error: unknown) => {
      logged.push(error)
      if (error === observerError) observerLogged.resolve()
    }
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
    await expect(disposal).resolves.toBeUndefined()
    expect(fiber.state).to.equal(FiberState.DISPOSED)
    expect(logged).to.deep.equal([cleanupError])

    observerGate.resolve()
    await observerLogged.promise
    expect(logged).to.deep.equal([cleanupError, observerError])
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
