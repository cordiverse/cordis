import { Context, CordisError, FiberState } from '../src'
import { expect, describe, it, vi } from 'vitest'
import { mock } from 'node:test'
import { sleep, withTimers } from './utils'

describe('Effects', () => {
  it('dispose by plugin', async () => {
    const root = new Context()
    const dispose = mock.fn()
    const fiber = await root.plugin((ctx) => {
      ctx.effect(() => dispose, 'test')
    })
    expect(fiber.getEffects()).to.deep.equal([
      { label: 'test', children: [] },
    ])
    expect(dispose.mock.calls).to.have.length(0)
    const task = fiber.dispose()
    expect(fiber.dispose()).to.equal(task)
    await task
    expect(dispose.mock.calls).to.have.length(1)
    await fiber.dispose()
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('dispose manually', async () => {
    const root = new Context()
    const dispose1 = mock.fn()
    const dispose2 = root.effect(() => dispose1)
    expect(root.fiber.getEffects()).to.deep.equal([
      { label: 'anonymous', children: [] },
    ])
    expect(dispose1.mock.calls).to.have.length(0)
    dispose2()
    expect(dispose1.mock.calls).to.have.length(1)
    dispose2()
    expect(dispose1.mock.calls).to.have.length(1)
  })

  it('yield dispose', async () => {
    const root = new Context()
    const seq: number[] = []
    const dispose1 = mock.fn(() => seq.push(1))
    const dispose2 = mock.fn(() => seq.push(2))
    const dispose3 = mock.fn(() => seq.push(3))
    const dispose = root.effect(function* () {
      yield dispose1
      yield root.on('custom-event', () => {})
      yield dispose2
      yield root.effect(function* () {
        yield root.on('custom-event', () => {})
        yield dispose3
      })
    })
    root.on('custom-event', () => {})
    expect(root.fiber.getEffects()).to.deep.equal([
      {
        label: 'anonymous',
        children: [
          // only root level anonymous effects are included
          { label: 'ctx.on("custom-event")', children: [] },
          {
            label: 'anonymous',
            children: [
              { label: 'ctx.on("custom-event")', children: [] },
            ],
          },
        ],
      },
      { label: 'ctx.on("custom-event")', children: [] },
    ])
    expect(seq).to.deep.equal([])
    const task = dispose()
    expect(dispose()).to.equal(task)
    await task
    expect(seq).to.deep.equal([3, 2, 1])
    await dispose()
    expect(seq).to.deep.equal([3, 2, 1])
  })

  it('async return 1', withTimers(async (root) => {
    const seq: number[] = []
    const dispose = root.effect(async () => {
      await sleep(100)
      seq.push(1)
      return () => seq.push(2)
    })
    expect(seq).to.deep.equal([])
    await vi.advanceTimersByTimeAsync(100)
    expect(seq).to.deep.equal([1])
    await dispose()
    expect(seq).to.deep.equal([1, 2])
  }))

  it('async return 2', withTimers(async (root) => {
    const seq: number[] = []
    const dispose = root.effect(async () => {
      await sleep(100)
      seq.push(1)
      return () => seq.push(2)
    })
    dispose()
    expect(seq).to.deep.equal([])
    await vi.advanceTimersByTimeAsync(100)
    expect(seq).to.deep.equal([1, 2])
  }))

  it('async yield 1', withTimers(async (root) => {
    const seq: number[] = []
    const dispose = root.effect(async function* () {
      await sleep(100)
      seq.push(1)
      yield () => seq.push(2)
      await sleep(100)
      seq.push(3)
      yield () => seq.push(4)
      await sleep(100)
      seq.push(5)
      yield () => seq.push(6)
    })
    expect(seq).to.deep.equal([])
    await vi.advanceTimersByTimeAsync(300)
    expect(seq).to.deep.equal([1, 3, 5])
    await dispose()
    expect(seq).to.deep.equal([1, 3, 5, 6, 4, 2])
  }))

  it('async yield 2 (aborted)', withTimers(async (root) => {
    const seq: number[] = []
    const dispose = root.effect(async function* () {
      await sleep(100)
      seq.push(1)
      yield () => seq.push(2)
      await sleep(100)
      seq.push(3)
      yield () => seq.push(4)
      await sleep(100)
      seq.push(5)
      yield () => seq.push(6)
    })
    await vi.advanceTimersByTimeAsync(50)
    dispose()
    expect(seq).to.deep.equal([])
    await vi.advanceTimersByTimeAsync(300)
    expect(seq).to.deep.equal([1, 2])
  }))

  it('async yield 3 (aborted)', withTimers(async (root) => {
    const seq: number[] = []
    const dispose = root.effect(async function* () {
      await sleep(100)
      seq.push(1)
      yield () => seq.push(2)
      await sleep(100)
      seq.push(3)
      yield () => seq.push(4)
      await sleep(100)
      seq.push(5)
      yield () => seq.push(6)
    })
    expect(seq).to.deep.equal([])
    await vi.advanceTimersByTimeAsync(100)
    expect(seq).to.deep.equal([1])
    dispose()
    expect(seq).to.deep.equal([1])
    await vi.advanceTimersByTimeAsync(200)
    expect(seq).to.deep.equal([1, 3, 4, 2])
  }))

  it('async yield 4 (await dispose)', withTimers(async (root) => {
    const seq: number[] = []
    const dispose = root.effect(async function* () {
      await sleep(100)
      seq.push(1)
      yield () => seq.push(2)
      await sleep(100)
      seq.push(3)
      yield () => seq.push(4)
      await sleep(100)
      seq.push(5)
      yield () => seq.push(6)
    })
    expect(seq).to.deep.equal([])
    const [dispose2] = await Promise.all([dispose, vi.advanceTimersByTimeAsync(300)])
    expect(seq).to.deep.equal([1, 3, 5])
    await dispose2()
    expect(seq).to.deep.equal([1, 3, 5, 6, 4, 2])
  }))

  it('return with error', async () => {
    const root = new Context()
    const seq: number[] = []
    expect(() => {
      root.effect(() => {
        throw new Error('test')
        return () => seq.push(1)
      })
    }).to.throw('test')
    expect(seq).to.deep.equal([])
  })

  it('yield with error', async () => {
    const root = new Context()
    const seq: number[] = []
    expect(() => {
      root.effect(function* () {
        yield () => seq.push(1)
        throw new Error('test')
        yield () => seq.push(2)
      })
    }).to.throw('test')
    expect(seq).to.deep.equal([1])
  })

  it('async return with error', async () => {
    const root = new Context()
    const seq: number[] = []
    const dispose = root.effect(async () => {
      throw new Error('test')
      return () => seq.push(1)
    })
    expect(seq).to.deep.equal([])
    await expect(Promise.resolve(dispose)).rejects.toThrow()
    expect(seq).to.deep.equal([])
  })

  it('async yield with error', async () => {
    const root = new Context()
    const seq: number[] = []
    const dispose = root.effect(async function* () {
      yield () => seq.push(1)
      throw new Error('test')
      yield () => seq.push(2)
    })
    expect(seq).to.deep.equal([])
    let caught: unknown
    try {
      await dispose
    } catch (e) {
      caught = e
    }
    expect(caught).to.be.instanceOf(Error)
    expect(seq).to.deep.equal([1])
  })

  it('returns one disposal promise and joins cleanup already in progress', async () => {
    const root = new Context()
    const gate = Promise.withResolvers<void>()
    let cleanupStarted = false
    const dispose = root.effect(() => async () => {
      cleanupStarted = true
      await gate.promise
    })

    const first = dispose()
    const second = dispose()
    expect(first).to.equal(second)
    expect(cleanupStarted).to.be.true

    const restarting = root.fiber.restart()
    let settled = false
    void restarting.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).to.be.false

    gate.resolve()
    await Promise.all([first, restarting])
    expect(dispose()).to.equal(first)
  })

  it('attempts every cleanup in LIFO order and aggregates failures deterministically', async () => {
    const root = new Context()
    const sequence: number[] = []
    const first = new Error('first')
    const third = new Error('third')
    const dispose = root.effect(function* () {
      yield () => {
        sequence.push(1)
        throw first
      }
      yield async () => {
        await Promise.resolve()
        sequence.push(2)
      }
      yield () => {
        sequence.push(3)
        throw third
      }
    })

    const error = await dispose().catch(error => error)
    expect(sequence).to.deep.equal([3, 2, 1])
    expect(error).to.be.instanceOf(AggregateError)
    expect(error.errors).to.deep.equal([third, first])
  })

  it('preserves an AggregateError thrown by user cleanup as one failure', async () => {
    const root = new Context()
    const nested = new AggregateError([new Error('a'), new Error('b')], 'user aggregate')
    const other = new Error('other')
    const dispose = root.effect(function* () {
      yield () => { throw nested }
      yield () => { throw other }
    })

    const error = await dispose().catch(error => error)
    expect(error).to.be.instanceOf(AggregateError)
    expect(error.errors).to.deep.equal([other, nested])
  })

  it('keeps a direct cleanup failure observable through the shared promise', async () => {
    const root = new Context()
    const error = new Error('cleanup failed')
    const dispose = root.effect(() => () => { throw error })

    const task = dispose()
    expect(dispose()).to.equal(task)
    await expect(task).rejects.toBe(error)
    await expect(dispose()).rejects.toBe(error)
  })

  it('contains cleanup failure at structural restart', async () => {
    const root = new Context()
    const error = new Error('cleanup failed')
    const logged: unknown[] = []
    ;(root.logger as any).error = (value: unknown) => { logged.push(value) }
    root.effect(() => () => { throw error })

    await expect(root.fiber.restart()).resolves.toBeUndefined()
    expect(root.fiber.state).to.equal(FiberState.ACTIVE)
    expect(logged).to.deep.equal([error])
  })

  it('separates synchronous execution and rollback cleanup failures', async () => {
    const root = new Context()
    const logged: unknown[] = []
    ;(root.logger as any).error = (error: unknown) => { logged.push(error) }
    const executionError = new Error('execution failed')
    const cleanupError = new Error('cleanup failed')
    let restarting!: Promise<void>

    expect(() => root.effect(function* () {
      yield () => { throw cleanupError }
      restarting = root.fiber.restart()
      throw executionError
    })).to.throw(executionError)

    await expect(restarting).resolves.toBeUndefined()
    expect(root.fiber.state).to.equal(FiberState.ACTIVE)
    expect(logged).to.deep.equal([cleanupError])
  })

  it('removes a synchronously failed effect after rolling back collected cleanup', () => {
    const root = new Context()
    let cleanups = 0

    expect(() => root.effect(function* () {
      yield () => { cleanups += 1 }
      throw new Error('execution failed')
    })).to.throw('execution failed')

    expect(cleanups).to.equal(1)
    expect(root.fiber.getEffects()).to.deep.equal([])
  })

  it('makes reentrant restart await async rollback without replaying the execution failure', async () => {
    const root = new Context()
    const cleanupGate = Promise.withResolvers<void>()
    const cleanupStarted = Promise.withResolvers<void>()
    const executionError = new Error('execution failed')
    let restarting!: Promise<void>

    expect(() => root.effect(function* () {
      yield async () => {
        cleanupStarted.resolve()
        await cleanupGate.promise
      }
      restarting = root.fiber.restart()
      throw executionError
    })).to.throw(executionError)

    await cleanupStarted.promise
    let settled = false
    void restarting.finally(() => { settled = true }).catch(() => {})
    await Promise.resolve()
    expect(settled).to.be.false

    cleanupGate.resolve()
    await expect(restarting).resolves.toBeUndefined()
    expect(root.fiber.getEffects()).to.deep.equal([])
  })

  it('separates asynchronous execution and disposal failures', async () => {
    const root = new Context()
    const executionError = new Error('execution failed')
    const cleanupError = new Error('cleanup failed')
    const effect = root.effect(async function* () {
      yield () => { throw cleanupError }
      throw executionError
    })

    await expect(Promise.resolve(effect)).rejects.toBe(executionError)
    await expect(effect()).rejects.toBe(cleanupError)
  })

  it('logs auto-rollback cleanup failure once when a structural owner joins', async () => {
    const root = new Context()
    const logged: unknown[] = []
    ;(root.logger as any).error = (error: unknown) => { logged.push(error) }
    const restartStarted = Promise.withResolvers<void>()
    const executionError = new Error('execution failed')
    const cleanupError = new Error('cleanup failed')
    let restarting!: Promise<void>
    const effect = root.effect(async function* () {
      yield () => { throw cleanupError }
      restarting = root.fiber.restart()
      restartStarted.resolve()
      throw executionError
    })

    await restartStarted.promise
    await expect(Promise.resolve(effect)).rejects.toBe(executionError)
    await expect(restarting).resolves.toBeUndefined()
    expect(logged).to.deep.equal([executionError, cleanupError])
  })

  it('makes reentrant restart await async execution and cleanup', async () => {
    const root = new Context()
    const executionGate = Promise.withResolvers<void>()
    const cleanupGate = Promise.withResolvers<void>()
    const cleanupStarted = Promise.withResolvers<void>()
    let restarting!: Promise<void>

    root.effect(async () => {
      restarting = root.fiber.restart()
      await executionGate.promise
      return async () => {
        cleanupStarted.resolve()
        await cleanupGate.promise
      }
    })

    executionGate.resolve()
    await cleanupStarted.promise
    let settled = false
    void restarting.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).to.be.false

    cleanupGate.resolve()
    await restarting
    expect(root.fiber.getEffects()).to.deep.equal([])
  })

  it('rejects effect registration during unload', async () => {
    const root = new Context()
    let registrationError: unknown
    root.effect(() => () => {
      try {
        root.effect(() => () => {})
      } catch (error) {
        registrationError = error
      }
    })

    await root.fiber.restart()
    expect(registrationError).to.be.instanceOf(CordisError)
    expect((registrationError as CordisError).code).to.equal('INACTIVE_EFFECT')
    expect(root.fiber.state).to.equal(FiberState.ACTIVE)
  })

  it('accepts effects while a child is pending or loading', async () => {
    const root = new Context()
    const cleaned: string[] = []
    root.on('internal/plugin', (fiber) => {
      if (fiber.name !== 'state-probe' || fiber.uid === null) return
      expect(fiber.state).to.equal(FiberState.PENDING)
      fiber.ctx.effect(() => () => { cleaned.push('pending') })
    })

    const fiber = await root.plugin({
      name: 'state-probe',
      apply(ctx) {
        expect(ctx.fiber.state).to.equal(FiberState.LOADING)
        ctx.effect(() => () => { cleaned.push('loading') })
      },
    })
    await fiber.dispose()

    expect(cleaned).to.have.members(['pending', 'loading'])
  })
})
