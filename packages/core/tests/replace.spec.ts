import { expect, describe, it } from 'vitest'
import { Context, Fiber, FiberState } from '../src/index.ts'

describe('Registry.replace', () => {
  it('rebuilds the fiber against the next implementation', async () => {
    const root = new Context()
    const calls: string[] = []
    const old = (ctx: Context) => {
      calls.push('old')
      ctx.effect(() => () => calls.push('old-dispose'))
    }
    const next = (ctx: Context) => {
      calls.push('next')
      ctx.effect(() => () => calls.push('next-dispose'))
    }

    const fiber = root.plugin(old)
    await fiber.await()
    expect(calls).to.deep.equal(['old'])

    await root.registry.replace(old, next)
    expect(calls).to.deep.equal(['old', 'old-dispose', 'next'])
    expect(fiber.runtime!.callback).to.equal(next)
    expect(root.registry.get(next)).to.equal(root.registry.get(old))
    await root.fiber.dispose()
  })

  it('keeps the fiber, its uid and its place in the runtime', async () => {
    const root = new Context()
    const old = () => {}
    const next = () => {}

    const fiber = root.plugin(old)
    await fiber.await()
    const uid = fiber.uid

    const runtime = await root.registry.replace(old, next)
    expect(fiber.uid).to.equal(uid)
    // `ctx.plugin()` returns a wrapper, so compare the fibers by identity
    expect([...runtime!.fibers].map(fiber => fiber.uid)).to.deep.equal([uid])
    expect(root.registry.get(next)).to.equal(runtime)
    await root.fiber.dispose()
  })

  it('merges into a runtime that is already registered', async () => {
    const root = new Context()
    const old = () => {}
    const next = () => {}

    const first = root.plugin(old)
    const second = root.plugin(next)
    await Promise.all([first.await(), second.await()])
    expect(root.registry.size).to.equal(2)

    const target = root.registry.get(next)!
    await root.registry.replace(old, next)
    expect(root.registry.size).to.equal(1)
    expect(target.fibers).to.have.length(2)
    expect(root.registry.get(old)).to.equal(target)
    await root.fiber.dispose()
  })

  it('creates a fiber of the next plugin when the old one is used again', async () => {
    const root = new Context()
    const old = () => {}
    const next = () => {}

    await root.plugin(old).await()
    await root.registry.replace(old, next)
    const size = root.registry.size
    expect([...root.registry.keys()]).to.deep.equal([next])

    const fiber = root.plugin(old)
    await fiber.await()
    expect(fiber.runtime!.callback).to.equal(next)
    // the alias is not an implementation of its own
    expect(root.registry.size).to.equal(size)
    expect([...root.registry.keys()]).to.deep.equal([next])
    expect(root.registry.has(old)).to.equal(true)
    await root.fiber.dispose()
  })

  it('re-resolves inject from the next plugin', async () => {
    const root = new Context()
    const seen: any[] = []
    const old = () => {
      seen.push('old')
    }
    const next = Object.assign((ctx: Context) => {
      seen.push(ctx['foo'])
    }, { inject: ['foo'] as any })

    const fiber = root.plugin(old)
    await fiber.await()
    await root.registry.replace(old, next)
    // the new dependency is missing, so the fiber waits instead of running
    expect(seen).to.deep.equal(['old'])
    expect(fiber.state).to.equal(FiberState.PENDING)

    await root.plugin((ctx: Context) => {
      ctx.provide('foo', 'bar')
    }).await()
    await fiber.await()
    expect(seen).to.deep.equal(['old', 'bar'])
    await root.fiber.dispose()
  })

  it('emits internal/replace for each moved fiber', async () => {
    const root = new Context()
    const replaced: Fiber[] = []
    root.on('internal/replace', (fiber) => {
      replaced.push(fiber)
    })

    const old = () => {}
    const next = () => {}
    const first = root.plugin(old)
    const second = root.plugin(old)
    await Promise.all([first.await(), second.await()])

    await root.registry.replace(old, next)
    expect(replaced.map(fiber => fiber.uid)).to.deep.equal([first.uid, second.uid])
    await root.fiber.dispose()
  })

  it('clears a failure and retries with the next implementation', async () => {
    const root = new Context()
    const old = () => {
      throw new Error('boom')
    }
    const next = () => {}

    const fiber = root.plugin(old)
    await fiber.await().catch(() => {})
    expect(fiber.state).to.equal(FiberState.FAILED)

    await root.registry.replace(old, next)
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
  })

  it('validates the config with the schema of the next plugin', async () => {
    const root = new Context()
    let seen: any
    const old = () => {}
    const next = Object.assign((ctx: Context, config: any) => {
      seen = config
    }, {
      Config: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value: any) => ({ value: { n: value.n * 2 } }),
        },
      },
    })

    const fiber = root.plugin(old, { n: 2 })
    await fiber.await()
    await root.registry.replace(old, next)
    expect(seen).to.deep.equal({ n: 4 })
    await root.fiber.dispose()
  })

  it('propagates the replacement to a consumer through the new binding', async () => {
    const root = new Context()
    const values: string[] = []
    const old = Object.assign((ctx: Context) => {
      ctx.provide('svc', { value: 'old' })
    }, { provide: 'svc' })
    const next = Object.assign((ctx: Context) => {
      ctx.provide('svc', { value: 'next' })
    }, { provide: 'svc' })
    const consumer = Object.assign((ctx: Context) => {
      values.push(ctx['svc'].value)
    }, { inject: ['svc'] as any })

    await root.plugin(old).await()
    const fiber = root.plugin(consumer)
    await fiber.await()
    expect(values).to.deep.equal(['old'])

    await root.registry.replace(old, next)
    // the provider withdrew and re-installed its binding, so the consumer follows
    expect(values).to.deep.equal(['old', 'next'])
    await root.fiber.dispose()
  })

  it('follows a chain of replacements', async () => {
    const root = new Context()
    const a = () => {}
    const b = () => {}
    const c = () => {}

    await root.plugin(a).await()
    await root.registry.replace(a, b)
    await root.registry.replace(b, c)
    expect(root.registry.size).to.equal(1)
    expect(root.registry.get(a)).to.equal(root.registry.get(c))

    const fiber = root.plugin(a)
    await fiber.await()
    expect(fiber.runtime!.callback).to.equal(c)
    expect(root.registry.size).to.equal(1)
    await root.fiber.dispose()
  })

  it('does nothing when the plugin is not registered', async () => {
    const root = new Context()
    const old = () => {}
    const next = () => {}
    expect(await root.registry.replace(old, next)).to.be.undefined
    expect(root.registry.size).to.equal(0)
  })
})
