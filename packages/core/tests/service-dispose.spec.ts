import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { Context, Fiber, Service } from '../src'

function fixture() {
  const root = new Context()
  const timeline: string[] = []
  const gate = Promise.withResolvers<void>()
  let closed = false
  class Provider extends Service {
    constructor(ctx: Context) {
      super(ctx, 'foo')
    }

    * [Service.init]() {
      closed = false
      yield () => {
        closed = true
        timeline.push('provider closed')
      }
    }

    read() {
      timeline.push(`consumer read: ${closed ? 'closed' : 'open'}`)
    }
  }
  return { root, Provider, gate, timeline, isClosed: () => closed }
}

describe('Service disposal', () => {
  it.each(['consumer', 'provider', 'root'])('releases an injected binding after providing the same name in another realm (%s)', async (action) => {
    const root = new Context()
    const provider = await root.plugin(ctx => ctx.provide('foo', { value: 1 }))
    const consumer = await root.inject(['foo'], (ctx) => {
      ctx.isolate('foo').provide('foo', { outer: ctx.foo })
    })
    const task = action === 'root' ? root.fiber.dispose()
      : action === 'provider' ? provider.dispose()
        : consumer.dispose().then(() => provider.dispose())
    let disposed = false
    task.then(() => disposed = true)
    await setImmediate()
    expect(disposed).toBe(true)
    await task
    await root.fiber.dispose()
  })

  it('waits for a disposing consumer that has already left the registry', async () => {
    const root = new Context()
    const gate = Promise.withResolvers<void>()
    const timeline: string[] = []
    const provider = await root.plugin(() => {})
    const withdraw = provider.ctx.provide('foo', {})
    const consumer = await root.inject(['foo'], () => async () => {
      await gate.promise
      timeline.push('consumer finished')
    })
    const disposing = consumer.dispose()
    let withdrawn = false
    const withdrawing = Promise.resolve(withdraw()).then(() => {
      withdrawn = true
      timeline.push('withdraw completed')
    })
    await setImmediate()
    const withdrawnDuringCleanup = withdrawn
    gate.resolve()
    await Promise.all([disposing, withdrawing])
    expect(withdrawnDuringCleanup).toBe(false)
    expect(timeline).toEqual(['consumer finished', 'withdraw completed'])
    await root.fiber.dispose()
  })

  it('withdraws one binding without waiting for another binding from the same provider', async () => {
    const root = new Context()
    const gate = Promise.withResolvers<void>()
    const provider = await root.plugin(() => {})
    const withdraw = provider.ctx.provide('foo', {})
    provider.ctx.provide('bar', {})
    const first = await root.inject(['foo'], () => {})
    const second = await root.inject(['bar'], () => async () => {
      await gate.promise
    })
    const disposing = second.dispose()
    let withdrawn = false
    const withdrawing = Promise.resolve(withdraw()).then(() => withdrawn = true)
    await setImmediate()
    const withdrawnDuringOtherCleanup = withdrawn
    gate.resolve()
    await Promise.all([disposing, withdrawing])
    expect(withdrawnDuringOtherCleanup).toBe(true)
    await first.dispose()
    await root.fiber.dispose()
  })

  it.each(['provider', 'root', 'provider first', 'consumer first', 'restart'])(
    'retains resources during consumer cleanup (%s)', async (action) => {
      const { root, Provider, gate, timeline, isClosed } = fixture()
      const provider = await root.plugin(Provider)
      const consumer = await root.inject(['foo'], (ctx) => {
        ctx.effect(() => async () => {
          await gate.promise
          ctx.foo.read()
        })
      })
      let task: Promise<unknown>
      if (action === 'root') {
        task = root.fiber.dispose()
      } else if (action === 'restart') {
        task = provider.restart()
      } else if (action === 'consumer first') {
        task = Promise.all([consumer.dispose(), provider.dispose()])
      } else if (action === 'provider first') {
        task = Promise.all([provider.dispose(), consumer.dispose()])
      } else {
        task = provider.dispose()
      }
      await setImmediate()
      const closedDuringDrain = isClosed()
      gate.resolve()
      await task
      expect(closedDuringDrain).toBe(false)
      expect(timeline).toEqual(['consumer read: open', 'provider closed'])
      if (action === 'restart') {
        await consumer.await()
        expect(consumer.ctx.foo).toBeDefined()
      }
      await root.fiber.dispose()
    },
  )

  it('retains transitive dependencies while a consumer providing another service drains', async () => {
    const { root, Provider, gate, timeline, isClosed } = fixture()
    const fibers: Fiber[] = []
    const owner = await root.plugin((ctx) => {
      fibers.push(ctx.plugin(Provider))
      fibers.push(ctx.inject(['foo'], (ctx) => {
        ctx.provide('bar', {})
        return () => ctx.foo.read()
      }))
      fibers.push(ctx.inject(['bar'], () => async () => {
        timeline.push('consumer draining')
        await gate.promise
        timeline.push('consumer finished')
      }))
    })
    await Promise.all(fibers.map(fiber => fiber.await()))
    const task = owner.dispose()
    await setImmediate()
    const closedDuringDrain = isClosed()
    gate.resolve()
    await task
    expect(closedDuringDrain).toBe(false)
    expect(timeline).toEqual(['consumer draining', 'consumer finished', 'consumer read: open', 'provider closed'])
  })

  it.each([false, true])('retains dependencies through in-flight setup and rollback (failure: %s)', async (fail) => {
    const { root, Provider, gate, timeline, isClosed } = fixture()
    const error = new Error('setup failed')
    const log = vi.spyOn(root.logger, 'error').mockImplementation(() => {})
    const provider = await root.plugin(Provider)
    const consumer = root.inject(['foo'], async function* (ctx) {
      timeline.push('setup started')
      yield () => {
        ctx.foo.read()
        timeline.push('setup rolled back')
      }
      await gate.promise
      ctx.foo.read()
      if (fail) throw error
    })
    await setImmediate()
    const task = provider.dispose()
    await setImmediate()
    const closedDuringSetup = isClosed()
    gate.resolve()
    await task
    await consumer.dispose()
    expect(closedDuringSetup).toBe(false)
    expect(timeline).toEqual(['setup started', 'consumer read: open', 'consumer read: open', 'setup rolled back', 'provider closed'])
    expect(log).toHaveBeenCalledTimes(fail ? 1 : 0)
    log.mockRestore()
  })

  it('releases dependencies after a cleanup error', async () => {
    const { root, Provider, timeline } = fixture()
    const error = new Error('cleanup failed')
    const log = vi.spyOn(root.logger, 'error').mockImplementation(() => {})
    await root.plugin(Provider)
    await root.inject(['foo'], ctx => () => {
      ctx.foo.read()
      throw error
    })
    await root.fiber.dispose()
    expect(timeline).toEqual(['consumer read: open', 'provider closed'])
    expect(log).toHaveBeenCalledWith(error)
    log.mockRestore()
  })

  it('keeps provider listeners alive through the final consumer event', async () => {
    const root = new Context()
    const received = vi.fn()
    await root.plugin((ctx) => {
      ctx.provide('foo', {})
      ctx.on('custom-event', received)
    })
    await root.inject(['foo'], ctx => async () => {
      await setImmediate()
      ctx.emit('custom-event')
    })
    await root.fiber.dispose()
    expect(received).toHaveBeenCalledOnce()
  })

  it('allows unrelated providers and sibling effects to clean up concurrently', async () => {
    const { root, Provider, gate, isClosed } = fixture()
    const independent = vi.fn()
    const sibling = vi.fn()
    await root.plugin(Provider)
    await root.plugin((ctx) => {
      ctx.provide('bar', {})
      return independent
    })
    await root.inject(['foo'], (ctx) => {
      ctx.effect(() => async () => {
        await gate.promise
        ctx.foo.read()
      })
      ctx.effect(() => sibling)
    })
    const task = root.fiber.dispose()
    await setImmediate()
    const duringDrain = [isClosed(), independent.mock.calls.length, sibling.mock.calls.length]
    gate.resolve()
    await task
    expect(duringDrain).toEqual([false, 1, 1])
  })

  it.each([false, true])('supports composed provider effects (owner shutdown: %s)', async (ownerShutdown) => {
    const root = new Context()
    const gate = Promise.withResolvers<void>()
    const timeline: string[] = []
    let closed = false
    let provider!: Fiber
    let consumer!: Fiber
    const owner = await root.plugin((ctx) => {
      provider = ctx.plugin((ctx) => {
        ctx.effect(function* () {
          yield ctx.effect(() => () => {
            closed = true
            timeline.push('provider closed')
          })
          yield ctx.provide('foo', { read: () => timeline.push(`consumer read: ${closed ? 'closed' : 'open'}`) })
        })
      })
      consumer = ctx.inject(['foo'], ctx => async () => {
        await gate.promise
        ctx.foo.read()
      })
    })
    await Promise.all([provider.await(), consumer.await()])
    const task = ownerShutdown ? owner.dispose() : provider.dispose()
    await setImmediate()
    const closedDuringDrain = closed
    gate.resolve()
    await task
    expect(closedDuringDrain).toBe(false)
    expect(timeline).toEqual(['consumer read: open', 'provider closed'])
    await owner.dispose()
  })

  it('keeps an inherited service accessible to a child in a composed effect', async () => {
    const root = new Context()
    const read = vi.fn()
    let child!: Fiber
    const owner = await root.plugin((ctx) => {
      ctx.provide('foo', { read })
      ctx.effect(function* () {
        child = ctx.plugin(ctx => () => ctx.foo.read())
        yield child.dispose
      })
    })
    await child.await()
    await owner.dispose()
    expect(read).toHaveBeenCalledOnce()
  })

  it('retains an ancestor injection until its child finishes cleanup', async () => {
    const { root, Provider, gate, timeline, isClosed } = fixture()
    await root.plugin(Provider)
    let child!: Fiber
    await root.inject(['foo'], (ctx) => {
      child = ctx.plugin(ctx => async () => {
        await gate.promise
        ctx.foo.read()
      })
    })
    await child.await()
    const task = root.fiber.dispose()
    await setImmediate()
    const closedDuringDrain = isClosed()
    gate.resolve()
    await task
    expect(closedDuringDrain).toBe(false)
    expect(timeline).toEqual(['consumer read: open', 'provider closed'])
  })

  it('waits for a child that explicitly injects its parent service', async () => {
    const { root, Provider, gate, timeline, isClosed } = fixture()
    const provider = await root.plugin(Provider)
    await provider.ctx.inject(['foo'], ctx => async () => {
      await gate.promise
      ctx.foo.read()
    })
    const task = provider.dispose()
    await setImmediate()
    const closedDuringDrain = isClosed()
    gate.resolve()
    await task
    expect(closedDuringDrain).toBe(false)
    expect(timeline).toEqual(['consumer read: open', 'provider closed'])
  })

  it.each([false, true])('tracks same-name services in separate isolation realms (root shutdown: %s)', async (rootShutdown) => {
    const root = new Context()
    const gate = Promise.withResolvers<void>()
    const first = Symbol('first')
    const second = Symbol('second')
    const closed = vi.fn()
    const read = vi.fn()
    const provider = await root.plugin((ctx) => {
      ctx.isolate('foo', first).provide('foo', { read })
      ctx.isolate('foo', second).provide('foo', {})
      return closed
    })
    let draining = false
    const consumer = await root.isolate('foo', first).inject(['foo'], ctx => async () => {
      draining = true
      await gate.promise
      ctx.foo.read()
    })
    const task = rootShutdown ? root.fiber.dispose() : provider.dispose()
    await setImmediate()
    const closedDuringDrain = closed.mock.calls.length
    const notified = draining
    gate.resolve()
    await consumer.dispose()
    await task
    expect(closedDuringDrain).toBe(0)
    expect(notified).toBe(true)
    expect(read).toHaveBeenCalledOnce()
    expect(closed).toHaveBeenCalledOnce()
    await root.fiber.dispose()
  })

  it('withdraws only the old binding without waiting for the next load', async () => {
    const root = new Context()
    const oldCleanup = Promise.withResolvers<void>()
    const newSetup = Promise.withResolvers<void>()
    const versions: number[] = []
    const provider = await root.plugin(() => {})
    const withdraw = provider.ctx.provide('foo', { version: 1 })
    const consumer = await root.inject(['foo'], async (ctx) => {
      versions.push(ctx.foo.version)
      if (ctx.foo.version === 2) await newSetup.promise
      return async () => {
        await oldCleanup.promise
        versions.push(ctx.foo.version)
      }
    })
    let withdrawn = false
    const task = Promise.resolve(withdraw()).then(() => withdrawn = true)
    provider.ctx.provide('foo', { version: 2 })
    oldCleanup.resolve()
    await setImmediate()
    const withdrawnBeforeSetup = withdrawn
    const currentVersion = provider.ctx.foo?.version
    newSetup.resolve()
    await task
    await consumer.await()
    expect(withdrawnBeforeSetup).toBe(true)
    expect(currentVersion).toBe(2)
    expect(versions).toEqual([1, 1, 2])
    await root.fiber.dispose()
  })

  it('retains resources for an already withdrawn binding during provider disposal', async () => {
    const { root, Provider, gate, timeline, isClosed } = fixture()
    const provider = await root.plugin(Provider)
    const withdraw = provider.ctx.provide('bar', {})
    await root.inject(['bar'], () => async () => {
      await gate.promise
      timeline.push('consumer finished')
    })
    const withdrawal = withdraw()
    provider.ctx.provide('bar', {})
    const task = provider.dispose()
    await setImmediate()
    const closedDuringDrain = isClosed()
    gate.resolve()
    await Promise.all([withdrawal, task])
    expect(closedDuringDrain).toBe(false)
    expect(timeline).toEqual(['consumer finished', 'provider closed'])
    await root.fiber.dispose()
  })

  it('replaces a binding from the same provider during consumer initialization', async () => {
    const root = new Context()
    const setup = Promise.withResolvers<void>()
    const versions: number[] = []
    const withdraw = root.provide('foo', { version: 1 })
    const consumer = root.inject(['foo'], async (ctx) => {
      versions.push(ctx.foo.version)
      await setup.promise
      return () => { versions.push(-ctx.foo.version) }
    })
    await setImmediate()
    let withdrawn = false
    const task = Promise.resolve(withdraw()).then(() => withdrawn = true)
    root.provide('foo', { version: 2 })
    setup.resolve()
    await consumer.await()
    await setImmediate()
    const withdrawnAfterSetup = withdrawn
    const currentVersion = consumer.ctx.foo.version
    await consumer.dispose()
    await task
    expect(withdrawnAfterSetup).toBe(true)
    expect(currentVersion).toBe(2)
    expect(versions).toEqual([1, -1, 2, -2])
    await root.fiber.dispose()
  })
})
