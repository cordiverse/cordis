import { Context, CordisError, FiberState, type Fiber } from '../src'
import { describe, expect, it } from 'vitest'

describe('Cordis effect ownership', () => {
  it('makes an effect visible to a reentrant owner restart and awaits setup plus cleanup', async () => {
    const ctx = new Context()
    const setupGate = Promise.withResolvers<undefined>()
    const cleanupGate = Promise.withResolvers<undefined>()
    const cleanupStarted = Promise.withResolvers<undefined>()
    let restarted!: Promise<void>
    let setupFinished = false
    let cleanupFinished = false

    ctx.effect(async () => {
      restarted = ctx.fiber.restart()
      await setupGate.promise
      setupFinished = true
      return async () => {
        cleanupStarted.resolve(undefined)
        await cleanupGate.promise
        cleanupFinished = true
      }
    }, 'reentrant-restart')

    let settled = false
    void restarted.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    setupGate.resolve(undefined)
    await cleanupStarted.promise
    expect(setupFinished).toBe(true)
    await Promise.resolve()
    expect(settled).toBe(false)

    cleanupGate.resolve(undefined)
    await restarted
    expect(cleanupFinished).toBe(true)
    expect(ctx.fiber.getEffects()).toEqual([])
  })

  it('rolls back collected cleanup and its owner-list entry when setup throws synchronously', () => {
    const ctx = new Context()
    let cleanups = 0

    expect(() => ctx.effect(function* () {
      yield () => { cleanups += 1 }
      throw new Error('setup failed')
    }, 'throwing-setup')).toThrow('setup failed')

    expect(cleanups).toBe(1)
    expect(ctx.fiber.getEffects()).toEqual([])
  })

  it('makes a reentrant owner restart await asynchronous rollback after synchronous setup failure', async () => {
    const ctx = new Context()
    const cleanupGate = Promise.withResolvers<undefined>()
    const cleanupStarted = Promise.withResolvers<undefined>()
    let restarted!: Promise<void>

    expect(() => ctx.effect(function* () {
      yield async () => {
        cleanupStarted.resolve(undefined)
        await cleanupGate.promise
      }
      restarted = ctx.fiber.restart()
      throw new Error('setup failed after restart')
    }, 'reentrant-throw')).toThrow('setup failed after restart')

    await cleanupStarted.promise
    let settled = false
    void restarted.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    cleanupGate.resolve(undefined)
    await restarted
    expect(ctx.fiber.getEffects()).toEqual([])
  })

  it('keeps ordinary teardown synchronous and the public disposer single-shot', () => {
    const ctx = new Context()
    let cleanups = 0
    const dispose = ctx.effect(() => () => { cleanups += 1 }, 'sync-effect')

    expect(dispose()).toBeUndefined()
    expect(cleanups).toBe(1)
    expect(dispose()).toBeUndefined()
    expect(cleanups).toBe(1)
    expect(ctx.fiber.getEffects()).toEqual([])
  })

  it('keeps ordinary child disposal failure-containing but reports every nested failure from checked root disposal', async () => {
    const ordinary = new Context()
    const ordinaryErrors: unknown[] = []
    ordinary.logger.error = ((error: unknown) => { ordinaryErrors.push(error) }) as typeof ordinary.logger.error
    const ordinaryChild = await ordinary.plugin({
      name: 'ordinary-rejection',
      apply(inner) {
        inner.effect(() => async () => { throw new Error('ordinary cleanup failed') })
      },
    })
    await expect(ordinaryChild.dispose()).resolves.toBeUndefined()
    expect(ordinaryErrors).toEqual([expect.objectContaining({ message: 'ordinary cleanup failed' })])

    const checked = new Context()
    const checkedErrors: unknown[] = []
    checked.logger.error = ((error: unknown) => { checkedErrors.push(error) }) as typeof checked.logger.error
    let successfulCleanup = false
    await checked.plugin({
      name: 'checked-rejections',
      apply(inner) {
        inner.effect(() => async () => { throw new Error('nested cleanup failed') })
        inner.effect(() => () => { successfulCleanup = true })
      },
    })
    checked.effect(() => async () => { throw new Error('root cleanup failed') })

    const first = checked.fiber.disposeChecked()
    expect(checked.fiber.disposeChecked()).toBe(first)
    const failure = await first.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'nested cleanup failed' }),
      expect.objectContaining({ message: 'root cleanup failed' }),
    ]))
    expect(checkedErrors).toHaveLength(2)
    expect(successfulCleanup).toBe(true)
  })

  it('closes root admission before returning and lets lifecycle observers join the checked task', async () => {
    const ctx = new Context()
    let joined: Promise<void> | undefined
    ctx.on('internal/status', (fiber) => {
      if (fiber !== ctx.fiber || fiber.state !== FiberState.UNLOADING) return
      joined = fiber.disposeChecked()
    })

    const checked = ctx.fiber.disposeChecked()
    expect(joined).toBe(checked)
    expect(() => ctx.effect(() => () => {}, 'too-late-for-terminal-disposal')).toThrow(
      expect.objectContaining({ code: 'INACTIVE_EFFECT' }),
    )
    await expect(checked).resolves.toBeUndefined()
  })

  it('runs every yielded cleanup in reverse order before reporting composite failures', async () => {
    const ctx = new Context()
    const logged: unknown[] = []
    ctx.logger.error = ((error: unknown) => { logged.push(error) }) as typeof ctx.logger.error
    const calls: string[] = []
    ctx.effect(function* () {
      yield () => { calls.push('must-run') }
      yield () => {
        calls.push('sync-failure')
        throw new Error('second cleanup failed')
      }
      yield async () => {
        calls.push('async-start')
        await Promise.resolve()
        calls.push('async-failure')
        throw new Error('first cleanup failed')
      }
    }, 'composite-cleanup')

    const failure = await ctx.fiber.disposeChecked().catch((error: unknown) => error)
    expect(calls).toEqual(['async-start', 'async-failure', 'sync-failure', 'must-run'])
    expect(failure).toBeInstanceOf(AggregateError)
    const [composite] = (failure as AggregateError).errors as unknown[]
    expect(composite).toBeInstanceOf(AggregateError)
    expect(composite).toMatchObject({
      message: 'Cordis composite effect disposal failed',
      errors: [
        expect.objectContaining({ message: 'first cleanup failed' }),
        expect.objectContaining({ message: 'second cleanup failed' }),
      ],
    })
    expect(logged).toEqual([composite])
  })

  it('imports failures from an active child unload that checked root disposal joins', async () => {
    const ctx = new Context()
    const hold = Promise.withResolvers<undefined>()
    const holdStarted = Promise.withResolvers<undefined>()
    const earlyLogged = Promise.withResolvers<undefined>()
    const logged: unknown[] = []
    ctx.logger.error = ((error: unknown) => {
      logged.push(error)
      if (error instanceof Error && error.message === 'early child cleanup failed') {
        earlyLogged.resolve(undefined)
      }
    }) as typeof ctx.logger.error
    const child = await ctx.plugin({
      name: 'overlapping-unload',
      apply(inner) {
        inner.effect(() => async () => {
          holdStarted.resolve(undefined)
          await hold.promise
        }, 'held-cleanup')
        inner.effect(() => async () => {
          throw new Error('early child cleanup failed')
        }, 'early-failure')
      },
    })

    const childDisposal = child.dispose()
    await Promise.all([holdStarted.promise, earlyLogged.promise])
    const checked = ctx.fiber.disposeChecked()
    let settled = false
    void checked.then(
      () => { settled = true },
      () => { settled = true },
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    hold.resolve(undefined)
    await expect(childDisposal).resolves.toBeUndefined()
    const failure = await checked.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'early child cleanup failed' }),
    ])
    expect(logged).toHaveLength(1)
  })

  it('does not carry a completed ordinary unload failure into later checked disposal', async () => {
    const ctx = new Context()
    const logged: unknown[] = []
    ctx.logger.error = ((error: unknown) => { logged.push(error) }) as typeof ctx.logger.error
    const child = await ctx.plugin({
      name: 'completed-unload',
      apply(inner) {
        inner.effect(() => async () => { throw new Error('completed cleanup failed') })
      },
    })

    await expect(child.dispose()).resolves.toBeUndefined()
    expect(logged).toEqual([expect.objectContaining({ message: 'completed cleanup failed' })])
    await expect(ctx.fiber.disposeChecked()).resolves.toBeUndefined()
  })

  it('rejects checked disposal on a non-root fiber', async () => {
    const ctx = new Context()
    const child = await ctx.plugin({ name: 'not-root', apply() {} })
    expect(() => child.disposeChecked()).toThrow('only supported on the root fiber')
    await ctx.fiber.dispose()
  })

  it('rejects cleanup-time registration while a restart is unloading', async () => {
    const ctx = new Context()
    let registrationError: unknown

    ctx.effect(() => () => {
      try {
        ctx.effect(() => () => {}, 'too-late')
      } catch (error) {
        registrationError = error
      }
    }, 'restart-cleanup')

    await ctx.fiber.restart()
    expect(registrationError).toBeInstanceOf(CordisError)
    expect((registrationError as CordisError).code).toBe('INACTIVE_EFFECT')
    expect(ctx.fiber.state).toBe(FiberState.ACTIVE)
    expect(ctx.fiber.getEffects()).toEqual([])
  })

  it('keeps effect registration legal while child fibers are PENDING and LOADING', async () => {
    const ctx = new Context()
    let pendingCleanup = false
    let loadingCleanup = false

    ctx.on('internal/plugin', (fiber) => {
      if (fiber.name !== 'state-probe' || fiber.uid === null) return
      expect(fiber.state).toBe(FiberState.PENDING)
      fiber.ctx.effect(() => () => { pendingCleanup = true }, 'pending-effect')
    })

    const fiber = await ctx.plugin({
      name: 'state-probe',
      apply(inner) {
        expect(inner.fiber.state).toBe(FiberState.LOADING)
        inner.effect(() => () => { loadingCleanup = true }, 'loading-effect')
      },
    })
    await fiber.dispose()

    expect(pendingCleanup).toBe(true)
    expect(loadingCleanup).toBe(true)
  })

  it('resolves dependencies that internal/plugin adds before child activation', async () => {
    const ctx = new Context()
    ctx.provide('late-inject', {})
    let applyCalls = 0

    ctx.on('internal/plugin', (fiber) => {
      if (fiber.name !== 'loader-shaped' || fiber.uid === null) return
      fiber.inject['late-inject'] = {}
    })

    const fiber = await ctx.plugin({
      name: 'loader-shaped',
      apply() {
        applyCalls += 1
      },
    })

    expect(applyCalls).toBe(1)
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })
})

describe('Cordis child publication ownership', () => {
  it('rolls back parent and runtime ownership when internal/plugin publication throws', () => {
    const ctx = new Context()
    const plugin = { name: 'publication-failure', apply() {} }
    ctx.on('internal/plugin', (fiber) => {
      if (fiber.name === plugin.name) throw new Error('publication failed')
    })

    expect(() => ctx.plugin(plugin)).toThrow('publication failed')
    expect(ctx.registry.has(plugin)).toBe(false)
  })

  it('contains teardown notification failures so ownership cleanup and peers complete', async () => {
    const ctx = new Context()
    const errors: unknown[] = []
    ctx.logger.error = ((error: unknown) => { errors.push(error) }) as typeof ctx.logger.error
    const observed: string[] = []
    ctx.on('internal/plugin', (fiber) => {
      if (fiber.name === 'contained-teardown' && fiber.uid === null) {
        throw new Error('broken teardown observer')
      }
    })
    ctx.on('internal/plugin', (fiber) => {
      if (fiber.name === 'contained-teardown' && fiber.uid === null) observed.push('disposed')
    })
    const child = await ctx.plugin({ name: 'contained-teardown', apply() {} })

    await expect(child.dispose()).resolves.toBeUndefined()
    expect(observed).toEqual(['disposed'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toEqual(expect.objectContaining({ message: 'broken teardown observer' }))
    expect(child.uid).toBeNull()
  })

  it('makes a LOADING parent join child cleanup started before its unload snapshot', async () => {
    const ctx = new Context()
    const cleanupGate = Promise.withResolvers<undefined>()
    const cleanupStarted = Promise.withResolvers<undefined>()
    let ownerFiber!: Fiber
    let ownerDisposal!: Promise<void>
    let childDisposal!: Promise<void>
    let childFiber!: Fiber

    ctx.on('internal/plugin', (fiber) => {
      if (fiber.name !== 'loading-child' || fiber.uid === null) return
      childFiber = fiber
      fiber.ctx.effect(() => async () => {
        cleanupStarted.resolve(undefined)
        await cleanupGate.promise
      }, 'loading-child-cleanup')
      ownerDisposal = ownerFiber.dispose()
      childDisposal = Promise.resolve(fiber.dispose())
    })

    const ownerMount = ctx.plugin({
      name: 'loading-owner',
      apply(inner) {
        ownerFiber = inner.fiber
        inner.plugin({ name: 'loading-child', apply() {} })
      },
    })

    await cleanupStarted.promise
    let ownerSettled = false
    void ownerDisposal.then(() => { ownerSettled = true })
    await Promise.resolve()
    expect(ownerSettled).toBe(false)

    cleanupGate.resolve(undefined)
    await Promise.all([ownerDisposal, childDisposal, ownerMount])
    expect(childFiber.uid).toBeNull()
    expect(ownerFiber.uid).toBeNull()
  })

  it('lets parent disposal during internal/plugin await the unpublished child to quiescence', async () => {
    const ctx = new Context()
    let ownerCtx!: Context
    const owner = await ctx.plugin({
      name: 'owner',
      apply(inner) {
        ownerCtx = inner
      },
    })

    const cleanupGate = Promise.withResolvers<undefined>()
    const cleanupStarted = Promise.withResolvers<undefined>()
    let cleanupFinished = false
    let childApplyCalls = 0
    let parentDisposal!: Promise<void>

    ctx.on('internal/plugin', (fiber) => {
      if (fiber.name !== 'child' || fiber.uid === null) return
      expect(fiber.state).toBe(FiberState.PENDING)
      fiber.ctx.effect(() => async () => {
        cleanupStarted.resolve(undefined)
        await cleanupGate.promise
        cleanupFinished = true
      }, 'pending-child-cleanup')
    })
    ctx.on('internal/plugin', (fiber) => {
      if (fiber.name !== 'child' || fiber.uid === null) return
      parentDisposal = owner.dispose()
    })

    const child = ownerCtx.plugin({
      name: 'child',
      apply() {
        childApplyCalls += 1
      },
    })

    await cleanupStarted.promise
    let settled = false
    void parentDisposal.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    cleanupGate.resolve(undefined)
    await parentDisposal
    expect(cleanupFinished).toBe(true)
    expect(childApplyCalls).toBe(0)
    expect(child.uid).toBeNull()
    expect(child.state).toBe(FiberState.DISPOSED)
  })
})
