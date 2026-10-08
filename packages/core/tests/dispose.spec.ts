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
    await fiber.dispose()
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
    dispose()
    expect(seq).to.deep.equal([3, 2, 1])
    dispose()
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
    await expect(dispose).rejects.toThrow()
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

  // a fiber that never activated still owns whatever an `internal/plugin`
  // observer registered on it, and `_setEpoch(INACTIVE)` has no transition to
  // drive for it — the disposables have to be unloaded explicitly
  it('dispose unloads effects of a fiber that never activated', async () => {
    const root = new Context()
    const unloaded = mock.fn()
    root.on('internal/plugin', (fiber) => {
      if (!fiber.uid) return
      fiber.ctx.effect(() => unloaded, 'observer')
    })
    const fiber = root.inject(['missing'], () => {})
    await sleep()
    expect(fiber.state).to.equal(FiberState.PENDING)
    await fiber.dispose()
    expect(unloaded.mock.calls).to.have.length(1)
    expect(fiber.state).to.equal(FiberState.DISPOSED)
  })

  // a registration made while the owner is unloading lands after `_unload()`
  // has cleared the list it drains, so it would outlive the teardown that was
  // supposed to own it
  it('rejects effect creation while the owner is unloading', async () => {
    const root = new Context()
    const disposeDep = root.provide('dep', 1)
    const late = mock.fn()
    let stateAtAttempt: FiberState | undefined
    let error: unknown

    const fiber = root.inject(['dep'], async (ctx) => {
      ctx.effect(() => () => {
        try {
          ctx.effect(() => late, 'late')
        } catch (reason) {
          stateAtAttempt = fiber.state
          error = reason
        }
      }, 'outer')
    })
    await sleep()
    expect(fiber.state).to.equal(FiberState.ACTIVE)

    disposeDep()
    await sleep()

    expect(stateAtAttempt).to.equal(FiberState.UNLOADING)
    expect(error).to.be.instanceOf(CordisError)
    expect((error as CordisError).code).to.equal('INACTIVE_EFFECT')
    expect(late.mock.calls).to.have.length(0)
    expect(fiber.state).to.equal(FiberState.PENDING)
  })

  // a throwing teardown observer must not starve its peers, and must not abort
  // the disposal that issued the notification
  it('contains a throwing teardown observer', async () => {
    const root = new Context()
    const errors = mock.fn()
    ;(root.logger as any).error = errors
    const seen: string[] = []

    root.on('internal/plugin', (fiber) => {
      if (fiber.uid !== null) return
      seen.push('first')
      throw new Error('observer boom')
    })
    root.on('internal/plugin', (fiber) => {
      if (fiber.uid !== null) return
      seen.push('second')
    })

    const cleaned = mock.fn()
    const fiber = root.inject([], async (ctx) => {
      ctx.effect(() => cleaned, 'e')
    })
    await sleep()

    await fiber.dispose()

    expect(seen).to.deep.equal(['first', 'second'])
    expect(cleaned.mock.calls).to.have.length(1)
    expect(fiber.state).to.equal(FiberState.DISPOSED)
    expect(errors.mock.calls.length).to.be.greaterThan(0)
  })

  // an observer may dispose the fiber from inside the publication notification,
  // so the disposer has to exist by then and the constructor must not carry on
  // into activation afterwards
  it('lets a publication observer dispose the fiber', async () => {
    const root = new Context()
    const applied = mock.fn()
    let disposedFromObserver = false

    root.on('internal/plugin', (fiber) => {
      if (fiber.uid === null || disposedFromObserver) return
      disposedFromObserver = true
      expect(typeof fiber.dispose).to.equal('function')
      fiber.dispose()
    })

    const fiber = root.inject([], async () => { applied() })
    await sleep()

    expect(disposedFromObserver).to.equal(true)
    expect(applied.mock.calls).to.have.length(0)
    expect(fiber.uid).to.equal(null)
  })
})
