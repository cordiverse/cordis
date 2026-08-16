import { expect, describe, it, beforeAll } from 'vitest'
import { Context, Fiber, FiberState } from 'cordis'
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
