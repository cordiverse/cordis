import { expect, describe, it, beforeAll } from 'vitest'
import { Context, Fiber, FiberState } from 'cordis'
import { EntryGroup } from '../src'
import MockLoader, { sleep } from './utils'

function passThrough(ctx: Context) {
  ctx.on('internal/update', (_config, _noSave, next) => next())
}

describe('Loader: persist only committed updates', () => {
  const root = new Context()
  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('foo', passThrough)
  })

  it('writes fiber.config, entry.options, and loader.data together', async () => {
    await loader.read([{ id: '1', name: 'foo' }])

    loader.expectFiber('1').update({ a: 3 })
    await sleep()

    expect(loader.expectFiber('1').config).to.deep.equal({ a: 3 })
    expect(loader.store['1']!.options.config).to.deep.equal({ a: 3 })
    expect(loader.data).to.deep.equal([{
      id: '1',
      name: 'foo',
      config: { a: 3 },
    }])
  })

  it('does not persist when noSave skips the writer', async () => {
    loader.expectFiber('1').update({ a: 9 }, true)
    await sleep()

    expect(loader.expectFiber('1').config).to.deep.equal({ a: 9 })
    expect(loader.store['1']!.options.config).to.deep.equal({ a: 3 })
    expect(loader.data[0].config).to.deep.equal({ a: 3 })
  })
})

describe('Loader: vetoed update does not persist', () => {
  const root = new Context()
  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('foo', (ctx: Context) => {
      ctx.on('internal/update', () => {})
    })
  })

  it('leaves fiber.config, entry.options, and loader.data unchanged', async () => {
    await loader.read([{ id: '1', name: 'foo' }])
    const before = structuredClone(loader.data)

    loader.expectFiber('1').update({ a: 3 })
    await sleep()

    expect(loader.expectFiber('1').config).to.not.deep.equal({ a: 3 })
    expect(loader.store['1']!.options.config).to.not.deep.equal({ a: 3 })
    expect(loader.data).to.deep.equal(before)
  })
})

describe('Loader: global veto does not persist', () => {
  const root = new Context()
  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('foo', passThrough)
    root.on('internal/update', function (this: Fiber, config, noSave, next) {
      if (this.entry?.options.id === '1' && config?.block) return
      return next()
    }, { global: true })
  })

  it('keeps persistence aligned with the skipped inner apply', async () => {
    await loader.read([{ id: '1', name: 'foo' }])

    loader.expectFiber('1').update({ block: true })
    await sleep()

    expect(loader.expectFiber('1').config).to.not.deep.equal({ block: true })
    expect(loader.store['1']!.options.config).to.not.deep.equal({ block: true })
    expect(loader.data).to.deep.equal([{ id: '1', name: 'foo' }])
  })
})

describe('Loader: group update still persists without calling next', () => {
  const root = new Context()
  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('foo', passThrough)
  })

  it('writes the new group config even though Group swallows next()', async () => {
    await loader.read([{
      id: 'g',
      name: '@cordisjs/plugin-group',
      group: true,
      config: [{ id: '1', name: 'foo' }],
    }])

    loader.expectFiber('g').update([
      { id: '1', name: 'foo' },
      { id: '2', name: 'foo' },
    ])
    await sleep()

    expect(loader.store['g']!.options.config).to.deep.equal([
      { id: '1', name: 'foo' },
      { id: '2', name: 'foo' },
    ])
    expect(loader.data[0].config).to.have.length(2)
    loader.expectEnable(loader.modules.foo)
  })

  it('still persists when Group runs without the group flag', async () => {
    await loader.read([{
      id: 'g',
      name: '@cordisjs/plugin-group',
      config: [{ id: '1', name: 'foo' }],
    }])

    loader.expectFiber('g').update([
      { id: '1', name: 'foo' },
      { id: '2', name: 'foo' },
    ])
    await sleep()

    expect(loader.store['g']!.options.config).to.deep.equal([
      { id: '1', name: 'foo' },
      { id: '2', name: 'foo' },
    ])
    expect(loader.data[0].config).to.have.length(2)
  })
})

describe('Loader: group intercept veto does not persist', () => {
  const root = new Context()
  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('foo', passThrough)
    const groupish = loader.mock('groupish', (ctx: Context) => {
      new EntryGroup(ctx, ctx.fiber.entry!.parent.tree)
      ctx.on('internal/update', () => {})
    })
    groupish[EntryGroup.key] = true
  })

  it('does not persist when a group intercept vetoes before assigning subgroup.data', async () => {
    // Fiber-local `internal/update` is a DisposableList (push-only), so a
    // later `{ prepend: true }` cannot run before Group. This plugin
    // registers the veto first; YAML `group: true` must not persist.
    await loader.read([{
      id: 'gv',
      name: 'groupish',
      group: true,
      config: [{ id: '1', name: 'foo' }],
    }])

    const before = structuredClone(loader.data)
    loader.expectFiber('gv').update([
      { id: '1', name: 'foo' },
      { id: '2', name: 'foo' },
    ])
    await sleep()

    expect(loader.store['gv']!.options.config).to.deep.equal([{ id: '1', name: 'foo' }])
    expect(loader.data).to.deep.equal(before)
  })
})

describe('Loader: same-reference veto does not persist', () => {
  const root = new Context()
  let loader!: MockLoader
  let allow = true

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('foo', (ctx: Context) => {
      ctx.on('internal/update', (_config, _noSave, next) => {
        if (allow) return next()
      })
    })
  })

  it('does not write in-place mutations when the update is vetoed', async () => {
    await loader.read([{ id: '1', name: 'foo' }])
    loader.expectFiber('1').update({ a: 1 })
    await sleep()

    allow = false
    const before = structuredClone(loader.data)
    const same = loader.expectFiber('1').config
    same.a = 2
    loader.expectFiber('1').update(same)
    await sleep()

    // Prior persist aliases entry.options.config to fiber.config, so in-place
    // mutation dirties live options. The write snapshot must stay unchanged.
    expect(loader.data).to.deep.equal(before)
  })
})

describe('Loader: failed restart does not persist', () => {
  const root = new Context()
  let loader!: MockLoader
  let booted = false

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    ;(root.logger as any).error = () => {}
    loader.mock('foo', (ctx: Context) => {
      passThrough(ctx)
      if (booted) throw new Error('reload fail')
      booted = true
    })
  })

  it('leaves persistence unchanged when apply throws on reload', async () => {
    await loader.read([{ id: '1', name: 'foo' }])
    const before = structuredClone(loader.data)
    const writes = loader.writes
    const fiber = loader.expectFiber('1')

    fiber.update({ a: 3 })
    await fiber.await().catch(() => {})
    await sleep()

    expect(fiber.state).to.equal(FiberState.FAILED)
    expect(loader.writes).to.equal(writes)
    expect(loader.store['1']!.options.config).to.not.deep.equal({ a: 3 })
    expect(loader.data).to.deep.equal(before)
  })
})

describe('Loader: persist waits for a thenable next()', () => {
  const root = new Context()
  let loader!: MockLoader
  let release!: () => void
  let gate!: Promise<void>

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('foo', (ctx: Context) => {
      ctx.on('internal/update', async (_config, _noSave, next) => {
        await gate
        return next()
      })
    })
  })

  it('does not write until a delayed next() settles, then persists the commit', async () => {
    await loader.read([{ id: '1', name: 'foo' }])
    gate = new Promise<void>((resolve) => { release = resolve })
    const writes = loader.writes
    const before = structuredClone(loader.data)

    loader.expectFiber('1').update({ a: 3 })
    await sleep()

    expect(loader.writes).to.equal(writes)
    expect(loader.data).to.deep.equal(before)

    release()
    await sleep()

    expect(loader.writes).to.equal(writes + 1)
    expect(loader.data[0].config).to.deep.equal({ a: 3 })
  })
})

describe('Loader: persist waits for restart to settle', () => {
  const root = new Context()
  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('foo', passThrough)
  })

  it('leaves persistence unchanged in the same turn as fiber.update()', async () => {
    await loader.read([{ id: '1', name: 'foo' }])
    const writes = loader.writes
    const fiber = loader.expectFiber('1')

    fiber.update({ a: 3 })

    expect(fiber.config).to.deep.equal({ a: 3 })
    expect(loader.writes).to.equal(writes)
    expect(loader.data[0].config).to.not.deep.equal({ a: 3 })

    await sleep()

    expect(loader.writes).to.equal(writes + 1)
    expect(loader.data[0].config).to.deep.equal({ a: 3 })
  })
})

describe('Loader: async veto does not persist', () => {
  const root = new Context()
  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('foo', (ctx: Context) => {
      ctx.on('internal/update', async () => {})
    })
  })

  it('skips write after a thenable veto settles', async () => {
    await loader.read([{ id: '1', name: 'foo' }])
    const writes = loader.writes
    const before = structuredClone(loader.data)

    loader.expectFiber('1').update({ a: 3 })
    await sleep()

    expect(loader.writes).to.equal(writes)
    expect(loader.data).to.deep.equal(before)
  })
})

describe('Loader: child dispose does not disable the entry', () => {
  const root = new Context()
  let loader!: MockLoader
  let child!: Fiber

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('foo', (ctx: Context) => {
      passThrough(ctx)
      child = ctx.plugin(() => {})
    })
  })

  it('keeps the parent entry enabled after a nested fiber dispose', async () => {
    await loader.read([{ id: '1', name: 'foo' }])
    expect(loader.expectFiber('1').state).to.equal(FiberState.ACTIVE)

    await child.dispose()
    await sleep()

    expect(loader.expectFiber('1').state).to.equal(FiberState.ACTIVE)
    expect(loader.store['1']!.options.disabled).to.not.be.ok
    expect(loader.data).to.deep.equal([{ id: '1', name: 'foo' }])
  })
})
