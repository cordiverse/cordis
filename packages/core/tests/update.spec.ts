import { Context, FiberState } from '../src/index.ts'
import { describe, expect, it } from 'vitest'
import { mock } from 'node:test'

describe('Fiber: concurrent updates', () => {
  // #34: a restart during loading must not disappear when dependencies match.
  it.each([false, true])('settles concurrent updates on the latest config (inject: %s)', async (inject) => {
    const root = new Context()
    root.provide('foo', 1)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const latestStarted = Promise.withResolvers<void>()
    const latestRelease = Promise.withResolvers<void>()
    const applied: number[] = []
    const disposed: number[] = []
    const settled = mock.fn()
    const fiber = await root.plugin({
      inject: inject ? ['foo'] : [],
      async apply(ctx: Context, config: { value: number }) {
        applied.push(config.value)
        if (inject) expect(ctx.foo).to.equal(1)
        if (config.value === 1) {
          started.resolve()
          await release.promise
        } else if (config.value === 3) {
          latestStarted.resolve()
          await latestRelease.promise
        }
        return () => { disposed.push(config.value) }
      },
    }, { value: 0 })

    const first = Promise.resolve(fiber.update({ value: 1 })).then(settled)
    await started.promise
    const second = Promise.resolve(fiber.update({ value: 2 })).then(settled)
    const third = Promise.resolve(fiber.update({ value: 3 })).then(settled)
    release.resolve()
    await latestStarted.promise

    expect(applied).to.deep.equal([0, 1, 3])
    expect(disposed).to.deep.equal([0, 1])
    expect(settled.mock.calls).to.have.length(0)
    expect(fiber.state).to.equal(FiberState.LOADING)
    latestRelease.resolve()
    await Promise.all([first, second, third])

    expect(settled.mock.calls).to.have.length(3)
    expect(fiber.config).to.deep.equal({ value: 3 })
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
    expect(disposed).to.deep.equal([0, 1, 3])
  })

  it('skips superseded loads before executing the plugin', async () => {
    const root = new Context()
    const applied: number[] = []
    const fiber = root.plugin((_ctx, config: { value: number }) => {
      applied.push(config.value)
    }, { value: 1 })
    const first = fiber.update({ value: 2 })
    const second = fiber.update({ value: 3 })
    await Promise.all([first, second, fiber.await()])

    expect(applied).to.deep.equal([3])
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
  })

  it('coalesces updates during unloading', async () => {
    const root = new Context()
    const unloading = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const applied: number[] = []
    const fiber = await root.plugin((_ctx, config: { value: number }) => {
      applied.push(config.value)
      return async () => {
        if (config.value !== 0) return
        unloading.resolve()
        await release.promise
      }
    }, { value: 0 })

    const first = fiber.update({ value: 1 })
    await unloading.promise
    const second = fiber.update({ value: 2 })
    expect(applied).to.deep.equal([0])
    expect(fiber.state).to.equal(FiberState.UNLOADING)
    release.resolve()
    await Promise.all([first, second])

    expect(applied).to.deep.equal([0, 2])
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
  })

  it.each(['restart', 'config ABA'])('honors %s while loading even when config is unchanged', async (mode) => {
    const root = new Context()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = { value: 1 }
    const applied: number[] = []
    const fiber = root.plugin(async (_ctx, config: { value: number }) => {
      applied.push(config.value)
      started.resolve()
      await release.promise
    }, original)

    await started.promise
    const updates = mode === 'restart'
      ? [fiber.restart()]
      : [fiber.update({ value: 2 }), fiber.update(original)]
    release.resolve()
    await Promise.all(updates)

    expect(applied).to.deep.equal([1, 1])
    expect(fiber.config).to.equal(original)
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
  })

  it('cleans up a superseded failure without failing the latest update', async () => {
    const root = new Context()
    const logged = mock.fn()
    ;(root.logger as any).error = logged
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const failure = new Error('superseded load')
    const applied: number[] = []
    const disposed: number[] = []
    const fiber = root.plugin(async (ctx, config: { value: number }) => {
      applied.push(config.value)
      ctx.effect(() => () => { disposed.push(config.value) })
      if (config.value !== 1) return
      started.resolve()
      await release.promise
      throw failure
    }, { value: 1 })

    await started.promise
    const updating = fiber.update({ value: 2 })
    release.resolve()
    await Promise.all([updating, fiber.await()])

    expect(applied).to.deep.equal([1, 2])
    expect(disposed).to.deep.equal([1])
    expect(logged.mock.calls).to.have.length(1)
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
    expect(disposed).to.deep.equal([1, 2])
  })

  it('rejects all waiting updates when the latest load fails', async () => {
    const root = new Context()
    ;(root.logger as any).error = mock.fn()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const applied: number[] = []
    const disposed: number[] = []
    const fiber = await root.plugin(async (ctx, config: { value: number }) => {
      applied.push(config.value)
      ctx.effect(() => () => { disposed.push(config.value) })
      if (config.value === 1) {
        started.resolve()
        await release.promise
      } else if (config.value === 2) {
        throw new Error('latest load failed')
      }
    }, { value: 0 })

    const first = fiber.update({ value: 1 })
    await started.promise
    const second = fiber.update({ value: 2 })
    const results = Promise.allSettled([first, second])
    release.resolve()

    for (const result of await results) {
      expect(result.status).to.equal('rejected')
      if (result.status === 'rejected') {
        expect(result.reason.message).to.equal('latest load failed')
      }
    }
    expect(applied).to.deep.equal([0, 1, 2])
    expect(disposed).to.deep.equal([0, 1, 2])
    expect(fiber.state).to.equal(FiberState.FAILED)
    await root.fiber.dispose()
  })

  it('stops advancing an outdated async generator and collects its final yield', async () => {
    const root = new Context()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const events: string[] = []
    const fiber = root.plugin(async function* (_ctx, config: { value: number }) {
      events.push(`load ${config.value}`)
      if (config.value !== 1) return
      started.resolve()
      await release.promise
      yield () => { events.push('dispose 1') }
      events.push('outdated continuation')
    }, { value: 1 })

    await started.promise
    const updating = fiber.update({ value: 2 })
    release.resolve()
    await updating

    expect(events).to.deep.equal(['load 1', 'dispose 1', 'load 2'])
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
  })

  it('waits for dependencies and loads only the latest config', async () => {
    const root = new Context()
    const applied: number[] = []
    const fiber = root.plugin({
      inject: ['foo'],
      apply(ctx: Context, config: { value: number }) {
        expect(ctx.foo).to.equal('available')
        applied.push(config.value)
      },
    }, { value: 0 })

    await Promise.all([fiber.update({ value: 1 }), fiber.update({ value: 2 })])
    expect(fiber.state).to.equal(FiberState.PENDING)
    expect(applied).to.deep.equal([])
    root.provide('foo', 'available')
    await fiber

    expect(applied).to.deep.equal([2])
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
  })

  it('does not restart when a listener accepts an update during loading', async () => {
    const root = new Context()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const applied: number[] = []
    const received: number[] = []
    const fiber = root.plugin(async (ctx, config: { value: number }) => {
      applied.push(config.value)
      ctx.on('internal/update', (config) => { received.push(config.value) })
      started.resolve()
      await release.promise
    }, { value: 1 })

    await started.promise
    await fiber.update({ value: 2 })
    release.resolve()
    await fiber

    expect(applied).to.deep.equal([1])
    expect(received).to.deep.equal([2])
    expect(fiber.config).to.deep.equal({ value: 2 })
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
  })

  it('does not load a queued config after disposal', async () => {
    const root = new Context()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const applied: number[] = []
    const disposed = mock.fn()
    const fiber = root.plugin(async (_ctx, config: { value: number }) => {
      applied.push(config.value)
      started.resolve()
      await release.promise
      return disposed
    }, { value: 1 })

    await started.promise
    const updating = fiber.update({ value: 2 })
    const disposing = fiber.dispose()
    release.resolve()
    await Promise.all([updating, disposing])

    expect(applied).to.deep.equal([1])
    expect(disposed.mock.calls).to.have.length(1)
    expect(fiber.state).to.equal(FiberState.DISPOSED)
    await root.fiber.dispose()
  })

  // #194: a listener that accepts the configuration without `next()` is invisible
  // to the state machine, so two updates can settle out of order
  describe('handler accepted without next()', () => {
    async function harness() {
      const root = new Context()
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const runs: number[] = []
      let applied = 0
      const fiber = await root.plugin((ctx: Context) => {
        ctx.on('internal/update', async (config: { value: number }) => {
          runs.push(config.value)
          if (config.value === 1) {
            started.resolve()
            await release.promise
          }
          applied = config.value
        })
      }, { value: 0 })
      return {
        root, started, release, runs, fiber,
        get applied() { return applied },
      }
    }

    it('replays a superseded handler against the stored config', async () => {
      const h = await harness()
      const first = Promise.resolve(h.fiber.update({ value: 1 }))
      await h.started.promise
      const second = Promise.resolve(h.fiber.update({ value: 2 }))
      await second
      expect(h.applied).to.equal(2)
      h.release.resolve()
      await first

      expect(h.fiber.config).to.deep.equal({ value: 2 })
      expect(h.applied).to.equal(2)
      // the third run is the repair: the handler is re-run, not rewound
      expect(h.runs).to.deep.equal([1, 2, 2])
      await h.root.fiber.dispose()
    })

    it('keeps the plugin loaded when updates only overlap', async () => {
      // #194: a plugin that accepts updates without calling next() must not be
      // unloaded just because updates overlapped
      const root = new Context()
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const bodies: number[] = []
      const disposed: number[] = []
      const fiber = await root.plugin((ctx: Context, config: { value: number }) => {
        bodies.push(config.value)
        ctx.on('internal/update', async (config: { value: number }) => {
          if (config.value === 1) {
            started.resolve()
            await release.promise
          }
        })
        return () => { disposed.push(config.value) }
      }, { value: 0 })

      const first = Promise.resolve(fiber.update({ value: 1 }))
      await started.promise
      const second = Promise.resolve(fiber.update({ value: 2 }))
      release.resolve()
      await Promise.all([first, second, fiber.await()])

      // an overlap unloads nothing: the body runs once and is never disposed
      expect(bodies).to.deep.equal([0])
      expect(disposed).to.deep.equal([])
      expect(fiber.state).to.equal(FiberState.ACTIVE)
      await root.fiber.dispose()
    })

    it('settles a burst of updates on the last config', async () => {
      const h = await harness()
      const first = Promise.resolve(h.fiber.update({ value: 1 }))
      await h.started.promise
      const rest = [2, 3, 4, 5].map((value) => Promise.resolve(h.fiber.update({ value })))
      h.release.resolve()
      await Promise.all([first, ...rest])

      expect(h.fiber.config).to.deep.equal({ value: 5 })
      expect(h.applied).to.equal(5)
      await h.root.fiber.dispose()
    })

    it('replays once for a burst of updates', async () => {
      const h = await harness()
      const first = Promise.resolve(h.fiber.update({ value: 1 }))
      await h.started.promise
      const rest = [2, 3, 4, 5].map((value) => Promise.resolve(h.fiber.update({ value })))
      h.release.resolve()
      await Promise.all([first, ...rest])

      // five runs plus one replay of the last config; replaying per superseded
      // caller behind a per-revision guard runs the handler eight times and
      // settles on the value the held chain wrote, the repair suppressed
      expect(h.runs).to.deep.equal([1, 2, 3, 4, 5, 5])
      await h.root.fiber.dispose()
    })

    it('accumulates handler-registered listeners across a replay', async () => {
      const root = new Context()
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let registrations = 0
      let calls = 0
      const fiber = await root.plugin((ctx: Context) => {
        // a listener registered in the handler body is created once per run, so the
        // replay repeats it; one in the plugin body would be created once per execution
        ctx.on('internal/update', async (config: { value: number }) => {
          registrations++
          ;(ctx as any).on('probe-event', () => { calls++ })
          if (config.value === 1) {
            started.resolve()
            await release.promise
          }
        })
      }, { value: 0 })

      const first = Promise.resolve(fiber.update({ value: 1 }))
      await started.promise
      const second = Promise.resolve(fiber.update({ value: 2 }))
      await second
      release.resolve()
      await first

      await (root as any).emit('probe-event')
      expect(registrations).to.equal(3)
      expect(calls).to.equal(3)
      await root.fiber.dispose()
    })

    // A2 of #194: an update that is still held must not leave a replacement
    // execution on its own state. The older handler does run after the restart
    // — the paper keeps that in the emission layer (4.3.5) — but the settled
    // state is the stored configuration, not the one the older handler wrote.
    it('settles a replacement execution on the stored config', async () => {
      const root = new Context()
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let applied = 0
      const order: string[] = []
      const fiber = await root.plugin((ctx: Context, config: { value: number }) => {
        applied = config.value
        order.push('apply:' + config.value)
        ctx.on('internal/update', async (config: { value: number }, next: () => any) => {
          if (config.value === 1) {
            started.resolve()
            await release.promise
          }
          order.push('write:' + config.value)
          applied = config.value
          await next()
        })
      }, { value: 0 })

      const first = Promise.resolve(fiber.update({ value: 1 }))
      await started.promise
      const second = Promise.resolve(fiber.update({ value: 2 }))
      await second
      release.resolve()
      await Promise.all([first, second])
      await new Promise((resolve) => setTimeout(resolve, 40))

      expect(fiber.config).to.deep.equal({ value: 2 })
      expect(applied).to.equal(2)
      // the older write is still visible, and the replay is what corrects it:
      // write:2 (the superseding chain), write:1 (the held handler resuming
      // after the restart), write:2 again (the replay). The middle one is the
      // emission layer of 4.3.5, the last one is the price of the repair.
      expect(order.filter((line) => line.startsWith('write:'))).to.deep.equal(['write:2', 'write:1', 'write:2'])
      await root.fiber.dispose()
    })

    it('adds no restart of its own when the handler calls next()', async () => {
      const root = new Context()
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      // one plugin body run per restart
      let runs = 0
      const fiber = await root.plugin(async (ctx: Context) => {
        runs++
        ctx.on('internal/update', async (config: { value: number }, next: () => any) => {
          if (config.value === 1) {
            started.resolve()
            await release.promise
          }
          return next()
        })
      }, { value: 0 })

      const first = Promise.resolve(fiber.update({ value: 1 }))
      await started.promise
      const second = Promise.resolve(fiber.update({ value: 2 }))
      await second
      expect(runs).to.equal(2)
      release.resolve()
      await first
      await fiber.await()

      // the late `next()` restarts once; the replay that follows re-runs the
      // handler against a no-op terminal, so it adds no restart of its own
      expect(runs).to.equal(3)
      await root.fiber.dispose()
    })

    it('does not commit the configuration again when it replays', async () => {
      const h = await harness()
      const commits: number[] = []
      h.root.on('internal/commit', (_fiber, config: { value: number }) => {
        commits.push(config.value)
      })

      const first = Promise.resolve(h.fiber.update({ value: 1 }))
      await h.started.promise
      const second = Promise.resolve(h.fiber.update({ value: 2 }))
      await second
      h.release.resolve()
      await first
      await h.fiber.await()

      // the replay re-runs the handlers only; committing again would write the
      // configuration back a second time on every superseded update
      expect(commits).to.deep.equal([1, 2])
      await h.root.fiber.dispose()
    })

    it('does not replay once the fiber has been unloaded', async () => {
      const root = new Context()
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const seen: any[] = []
      const withdraw = root.provide('dep', {})
      let target: any
      // a listener bound to the fiber is destroyed with its execution, so this
      // one has to outlive the unload to observe what the replay would run
      root.on('internal/update', async function (this: any, config: any) {
        if (this !== target) return
        seen.push(config)
        if (config?.value === 1) {
          started.resolve()
          await release.promise
        }
      }, { global: true })

      target = await root.plugin({ inject: ['dep'], apply() {} }, { value: 0 })

      const first = Promise.resolve(target.update({ value: 1 }))
      await started.promise
      withdraw()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(target.state).to.equal(FiberState.PENDING)

      const second = Promise.resolve(target.update({ value: 2 }))
      await second
      release.resolve()
      await first
      await new Promise<void>((resolve) => setTimeout(resolve, 20))

      // `update()` takes the restart branch without consulting the handlers while
      // the fiber is unloaded: replaying here would hand the surviving listener the
      // stored `{ value: 2 }` a second time, a configuration this execution never
      // accepted — measured, `[{ value: 1 }, { value: 2 }]` with the guard removed
      expect(seen).to.deep.equal([{ value: 1 }])
      await root.fiber.dispose()
    })

    it('refuses acquisition from a handler that outlives disposal', async () => {
      const root = new Context()
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const errors: string[] = []
      const disposed: string[] = []
      let listenerCalls = 0
      let uid: number | null = null
      let state = -1
      let acquired = 0
      const fiber = await root.plugin((ctx: Context) => {
        // registered before the update, so teardown owns them rather than the handler
        ctx.effect(() => () => { disposed.push('effect') })
        ;(ctx as any).on('probe-event', () => { listenerCalls++ })
        ctx.on('internal/update', async (config: { value: number }) => {
          if (config.value !== 1) return
          started.resolve()
          await release.promise
          // disposal overtook this handler: what it may still do is the question
          uid = ctx.fiber.uid
          state = ctx.fiber.state
          for (const acquire of [
            () => ctx.on('probe-event', () => {}),
            () => ctx.effect(() => {}),
            () => ctx.provide('probe-value', 1),
            () => ctx.set('probe-value', 1),
          ]) {
            try {
              acquire()
              acquired++
            } catch (error) {
              errors.push((error as Error).message)
            }
          }
        })
      }, { value: 0 })

      const updating = Promise.resolve(fiber.update({ value: 1 }))
      await started.promise
      // the hooks are live before the disposal: this is the control for the emit below
      await (root as any).emit('probe-event')
      await fiber.dispose()
      release.resolve()
      await updating

      expect(uid).to.equal(null)
      expect(state).to.equal(FiberState.DISPOSED)
      expect(acquired).to.equal(0)
      expect(errors).to.deep.equal([
        'cannot create effect on inactive context',
        'cannot create effect on inactive context',
        'cannot create effect on inactive context',
        'cannot set property "probe-value" without provide',
      ])
      // nothing registered through cordis outlives the disposal: the effect's
      // disposer ran, and the listener is unwound, so the emit calls it no more
      await (root as any).emit('probe-event')
      expect(listenerCalls).to.equal(1)
      expect(disposed).to.deep.equal(['effect'])
    })

    it('converges when a handler updates the fiber itself', async () => {
      const root = new Context()
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const runs: number[] = []
      let applied = 0
      let selfUpdate = false
      const fiber = await root.plugin((ctx: Context) => {
        ctx.on('internal/update', async (config: { value: number }) => {
          runs.push(config.value)
          if (config.value === 1) {
            started.resolve()
            await release.promise
          }
          applied = config.value
          // a handler may chain an update of its own: the nested chain runs
          // against the config it names, and the replay that follows has to
          // settle on that config rather than loop back to the one before it
          if (!selfUpdate) {
            selfUpdate = true
            void fiber.update({ value: 5 })
          }
        })
      }, { value: 0 })

      const first = Promise.resolve(fiber.update({ value: 1 }))
      await started.promise
      const second = Promise.resolve(fiber.update({ value: 2 }))
      await second
      expect(fiber.config).to.deep.equal({ value: 5 })
      release.resolve()
      await first
      await fiber.await()

      // three handler chains (1, 2, 5) and one replay of the newest config: the
      // nested update is a chain of its own, and the replay neither re-runs the
      // superseded ones nor starts a second loop of its own
      expect(runs).to.deep.equal([1, 2, 5, 5])
      expect(applied).to.equal(5)
      expect(fiber.config).to.deep.equal({ value: 5 })
      await root.fiber.dispose()
    })
  })
})
