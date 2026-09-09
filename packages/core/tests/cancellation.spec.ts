import { Context, Events, WaterfallNext } from '../src'
import { expect, describe, it } from 'vitest'
import { mock } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

declare module '../src/events' {
  interface Events {
    'test/waterfall'(value: number, next: (value?: number) => number): number
  }
}

function setup() {
  const root = new Context()
  return { root }
}

describe('Events: waterfallWith (checkpoint-only cancellation)', () => {
  it('signal already aborted: final handler never runs, throws abort reason', async () => {
    const { root } = setup()
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)
    const callback = mock.fn<Events['test/waterfall']>((value, next) => value + next())
    root.on('test/waterfall', callback)
    const final = mock.fn(() => 2)

    let caught: unknown
    try {
      root.waterfallWith({ signal: controller.signal }, 'test/waterfall', 1, final)
    } catch (err) {
      caught = err
    }
    expect(caught).to.equal(reason)
    expect(callback.mock.calls).to.have.length(0)
    expect(final.mock.calls).to.have.length(0)
  })

  it('signal already aborted without reason: throws AbortError', async () => {
    const { root } = setup()
    const controller = new AbortController()
    controller.abort()

    let caught: unknown
    try {
      root.waterfallWith({ signal: controller.signal }, 'test/waterfall', 1, () => 2)
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(DOMException)
    expect((caught as DOMException).name).to.equal('AbortError')
  })

  it('abort between middleware: downstream not entered, running middleware completes', async () => {
    const { root } = setup()
    const controller = new AbortController()
    const completed: string[] = []

    root.on('test/waterfall', async (value, next) => {
      controller.abort()
      await sleep(10)
      completed.push('first')
      return value + next()
    })
    const second = mock.fn<Events['test/waterfall']>((value, next) => value + next())
    root.on('test/waterfall', second)
    const final = mock.fn(() => 2)

    await expect(root.waterfallWith({ signal: controller.signal }, 'test/waterfall', 1, final))
      .rejects.toThrow(DOMException)
    expect(completed).toEqual(['first'])
    expect(second.mock.calls).to.have.length(0)
    expect(final.mock.calls).to.have.length(0)
  })

  it('next.signal is observable and works with throwIfAborted', async () => {
    const { root } = setup()
    const controller = new AbortController()
    let observed: WaterfallNext | undefined

    root.on('test/waterfall', (value, next) => {
      observed = next
      expect(next.signal).to.equal(controller.signal)
      next.signal.throwIfAborted()
      return value + next()
    })

    expect(root.waterfallWith({ signal: controller.signal }, 'test/waterfall', 1, () => 2)).to.equal(3)

    controller.abort()
    expect(() => observed!.signal!.throwIfAborted()).to.throw()
  })

  it('next.signal is undefined without a signal', async () => {
    const { root } = setup()
    root.on('test/waterfall', (value, next) => {
      expect(next.signal).to.be.undefined
      return value + next()
    })
    expect(root.waterfallWith({}, 'test/waterfall', 1, () => 2)).to.equal(3)
  })

  it('no signal: behavior identical to waterfall', async () => {
    const { root } = setup()
    const cb1 = mock.fn<Events['test/waterfall']>((value, next) => value + next())
    root.on('test/waterfall', cb1)
    const cb2 = mock.fn<Events['test/waterfall']>((value, next) => value + next())
    root.on('test/waterfall', cb2)
    expect(root.waterfallWith({}, 'test/waterfall', 1, () => 2)).to.equal(4)
  })

  it('no signal: sync short-circuit stops the chain', async () => {
    const { root } = setup()
    const cb1 = mock.fn<Events['test/waterfall']>((value, next) => value + next())
    root.on('test/waterfall', cb1)
    const cb2 = mock.fn<Events['test/waterfall']>((value, next) => value + next())
    root.on('test/waterfall', cb2)
    // a middleware that never calls next short-circuits the chain
    const cb3 = mock.fn<Events['test/waterfall']>((value) => value)
    root.on('test/waterfall', cb3)
    const cb4 = mock.fn<Events['test/waterfall']>((value, next) => value + next())
    root.on('test/waterfall', cb4)
    expect(root.waterfallWith({}, 'test/waterfall', 1, () => 2)).to.equal(3)
    expect(cb4.mock.calls).to.have.length(0)
  })

  it('no signal: thisArg overload', async () => {
    const { root } = setup()
    class Session { offset = 10 }
    const session = new Session()
    root.on('test/waterfall', function (this: Session, value: number, next: any) {
      return this.offset + next()
    })
    expect(root.waterfallWith({}, session, 'test/waterfall', 1, () => 2)).to.equal(13)
  })

  it('race: abort during running middleware settles once it settles, downstream skipped', async () => {
    const { root } = setup()
    const controller = new AbortController()
    let finished = false

    root.on('test/waterfall', async (value, next) => {
      // abort "while running", before returning
      controller.abort(new Error('gone'))
      await sleep(20)
      finished = true
      return value + next()
    })
    const final = mock.fn(() => 2)

    await expect(root.waterfallWith({ signal: controller.signal }, 'test/waterfall', 1, final))
      .rejects.toThrow('gone')
    expect(finished).to.be.true
    expect(final.mock.calls).to.have.length(0)
  })

  it('never-aborted signal behaves like plain waterfall', async () => {
    const { root } = setup()
    const controller = new AbortController()
    root.on('test/waterfall', (value, next) => value + next())
    expect(root.waterfallWith({ signal: controller.signal }, 'test/waterfall', 1, () => 2)).to.equal(3)
  })
})
