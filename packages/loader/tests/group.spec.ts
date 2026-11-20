import { Mock, mock } from 'node:test'
import { expect, describe, it, beforeAll, beforeEach } from 'vitest'
import { Context, FiberState, Service } from 'cordis'
import MockLoader, { sleep } from './utils.ts'

describe('Group: basic support', () => {
  const root = new Context()
  const dispose = mock.fn()

  let loader!: MockLoader
  let foo!: Mock<Function>

  beforeAll(async () => {
    await root.use(MockLoader)
    loader = root.loader as any
    foo = loader.mock('foo', () => dispose)
  })

  beforeEach(() => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()
  })

  let outer!: string
  let inner!: string

  it('initialize', async () => {
    outer = await loader.create({
      name: '@cordisjs/group',
      group: true,
      config: [{
        name: 'foo',
      }],
    })

    inner = await loader.create({
      name: '@cordisjs/group',
      group: true,
      config: [{
        name: 'foo',
      }],
    }, outer)

    await sleep()
    loader.expectFiber(outer)
    loader.expectFiber(inner)
    expect(foo.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(0)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('disable inner', async () => {
    await loader.update(inner, { disabled: true })

    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(1)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('disable outer', async () => {
    await loader.update(outer, { disabled: true })

    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(1)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('enable inner', async () => {
    await loader.update(inner, { disabled: null })

    expect(foo.mock.calls).to.have.length(0) // outer is still disabled
    expect(dispose.mock.calls).to.have.length(0)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('enable outer', async () => {
    await loader.update(outer, { disabled: null })

    await sleep()
    expect(foo.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(0)
    expect([...loader.entries()]).to.have.length(4)
  })
})

describe('Group: transfer', () => {
  const root = new Context()
  const dispose = mock.fn()

  let loader!: MockLoader
  let foo!: Mock<Function>

  beforeAll(async () => {
    await root.use(MockLoader)
    loader = root.loader as any
    foo = loader.mock('foo', () => dispose)
  })

  beforeEach(() => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()
  })

  let alpha!: string
  let beta!: string
  let gamma!: string
  let id!: string

  it('initialize', async () => {
    id = await loader.create({
      name: 'foo',
    })

    alpha = await loader.create({
      name: '@cordisjs/group',
      group: true,
      config: [],
    })

    beta = await loader.create({
      name: '@cordisjs/group',
      group: true,
      disabled: true,
      config: [],
    }, alpha)

    gamma = await loader.create({
      name: '@cordisjs/group',
      group: true,
      config: [],
    }, beta)

    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('enabled -> enabled', async () => {
    await loader.update(id, {}, alpha)

    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('enabled -> disabled', async () => {
    await loader.update(id, {}, beta)

    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(1)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('disabled -> disabled', async () => {
    await loader.update(id, {}, gamma)

    expect(foo.mock.calls).to.have.length(0) // outer is still disabled
    expect(dispose.mock.calls).to.have.length(0)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('disabled -> enabled', async () => {
    await loader.update(id, {}, null)

    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
    expect([...loader.entries()]).to.have.length(4)
  })

  // the cases below start from a loader of their own
  async function setup(options: object = {}) {
    const root = new Context()
    await root.use(MockLoader)
    const loader = root.loader as any as MockLoader
    const dispose = mock.fn()
    const foo = loader.mock('foo', () => dispose)
    loader.mock('settings', class extends Service {
      constructor(ctx: Context) {
        super(ctx, 'settings')
      }
    })
    await loader.read([
      { id: 'settings', name: 'settings' },
      { id: 'a', name: '@cordisjs/group', group: true, config: [{ id: 'x', name: 'foo', ...options }] },
      { id: 'b', name: '@cordisjs/group', group: true, config: [] },
    ])
    const { outerFiber, innerFiber } = loader.store['x']!
    loader.changes = []
    const expectKept = () => {
      const entry = loader.store['x']!
      for (const [fiber, expected] of [[entry.outerFiber, outerFiber], [entry.innerFiber, innerFiber]]) {
        expect(fiber?.uid).to.equal(expected?.uid)
        if (expected) expect(expected.state).to.equal(FiberState.ACTIVE)
      }
      expect(dispose.mock.calls).to.have.length(0)
      expect(entry.options.disabled).to.be.undefined
    }
    return { root, loader, foo, dispose, innerFiber, expectKept }
  }

  it.each([{}, { inject: ['settings'] }])('keeps an entry transferred out of a removed group (%o)', async (options) => {
    const { loader, dispose, expectKept } = await setup(options)
    loader.update('x', {}, 'b')
    loader.remove('a')
    await loader.await()
    expectKept()
    expect(loader.changes.every(change => !change.options?.disabled)).to.be.true

    // the target group owns the entry now
    loader.remove('b')
    await sleep()
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('keeps an entry transferred by a config file out of a removed group', async () => {
    const { loader, expectKept } = await setup()
    await loader.read([
      { id: 'settings', name: 'settings' },
      { id: 'b', name: '@cordisjs/group', group: true, config: [{ id: 'x', name: 'foo' }] },
    ])
    await loader.await()
    expectKept()
  })

  it('leaves nothing to a former group after the entry disposes itself', async () => {
    const { loader, innerFiber } = await setup()
    const effects = (id: string) => loader.expectFiber(id).getEffects().length
    const before = [effects('a'), effects('b')]
    await loader.update('x', {}, 'b')
    await loader.update('x', {}, 'a')
    await innerFiber!.dispose()
    expect(loader.store['x']!.options.disabled).to.be.true
    expect([effects('a'), effects('b')]).to.deep.equal([before[0] - 1, before[1]])
  })

  it('transfers an entry into a group that is being rebuilt', async () => {
    const { root, loader, foo, dispose } = await setup()
    loader.update('b', { inject: ['settings', 'missing'] })
    await loader.update('x', {}, 'b')
    await loader.await()
    // the entry is disposed once, with the group that holds it, and leaves no fiber behind
    await loader.ctx.fiber.dispose()
    expect(dispose.mock.calls).to.have.length(1)
    expect(root.registry.get(foo)?.fibers.length ?? 0).to.equal(0)
  })
})

describe('Group: awaited reconciliation', () => {
  const root = new Context()

  let loader!: MockLoader
  let foo!: Mock<Function>
  let bar!: Mock<Function>

  beforeAll(async () => {
    await root.use(MockLoader)
    loader = root.loader as any
    foo = loader.mock('foo', () => {})
    bar = loader.mock('bar', () => {})
  })

  let group!: string

  it('initialize', async () => {
    group = await loader.create({
      name: '@cordisjs/group',
      group: true,
      config: [{
        id: '1',
        name: 'foo',
      }],
    })

    await sleep()
    loader.expectEnable(foo)
    loader.expectDisable(bar)
  })

  it('config update settles children', async () => {
    // The group vetoes its own restart and reconciles children instead, so
    // that reconciliation is what the caller is really waiting for. A slow
    // import makes the difference observable: without the awaited chain the
    // update resolves while the new child is still being imported.
    const load = loader.import
    loader.import = async (name: string) => {
      await sleep(20)
      return load.call(loader, name)
    }
    try {
      await loader.update(group, {
        config: [{
          id: '1',
          name: 'foo',
        }, {
          id: '2',
          name: 'bar',
        }],
      })
    } finally {
      loader.import = load
    }

    loader.expectEnable(bar)
    loader.expectFiber('2')
  })
})

describe('Group: intercept', () => {
  const root = new Context()
  const callback = mock.fn()

  let loader!: MockLoader

  beforeAll(async () => {
    await root.use(MockLoader)
    loader = root.loader as any
    loader.mock('foo', (ctx: Context) => {
      callback(ctx[Context.intercept])
    })
  })

  beforeEach(() => {
    callback.mock.resetCalls()
  })

  let outer!: string
  let inner!: string
  let id!: string

  it('initialize', async () => {
    outer = await loader.create({
      name: '@cordisjs/group',
      group: true,
      intercept: {
        foo: {
          a: 1,
        },
      },
      config: [],
    })

    inner = await loader.create({
      name: '@cordisjs/group',
      group: true,
      intercept: {
        foo: {
          b: 2,
        },
      },
      config: [],
    }, outer)
    
    id = await loader.create({
      name: 'foo',
      intercept: {
        foo: {
          c: 3,
        },
      },
    }, inner)

    expect(callback.mock.calls).to.have.length(1)
    const intercept = callback.mock.calls[0].arguments[0]
    expect(intercept.foo).to.deep.equal({ c: 3 })
    expect(Object.getPrototypeOf(intercept).foo).to.deep.equal({ b: 2 })
    expect(Object.getPrototypeOf(Object.getPrototypeOf(intercept)).foo).to.deep.equal({ a: 1 })
  })
})
