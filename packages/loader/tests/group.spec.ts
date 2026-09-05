import { Mock, mock } from 'node:test'
import { expect, describe, it, beforeAll, beforeEach } from 'vitest'
import { Context } from 'cordis'
import { EntryTree } from '../src'
import MockLoader, { sleep } from './utils'

describe('Tree: nested removal', () => {
  it('removes an entry addressed by its composite id', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as MockLoader
    const dispose = mock.fn()
    loader.mock('foo', () => dispose)

    class NestedTree extends EntryTree {
      write() {}

      import(name: string) {
        return loader.import(name)
      }
    }

    let tree!: NestedTree
    loader.mock('tree', async (ctx) => {
      tree = new NestedTree(ctx)
      await tree.root.update([{ id: 'child', name: 'foo' }])
      return () => tree.root.stop()
    })

    const outer = await loader.create({ name: 'tree' })
    await loader.await()
    const child = `${outer}${EntryTree.sep}child`
    expect(loader.resolve(child).fiber).to.be.ok

    loader.remove(child)
    await sleep()

    expect(() => loader.resolve(child)).to.throw(`cannot resolve entry ${child}`)
    expect(dispose.mock.calls).to.have.length(1)
    expect(tree.root.data).to.deep.equal([])
  })
})

describe('Group: basic support', () => {
  const root = new Context()
  const dispose = mock.fn()

  let loader!: MockLoader
  let foo!: Mock<Function>

  beforeAll(async () => {
    await root.plugin(MockLoader)
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
      name: '@cordisjs/plugin-group',
      group: true,
      config: [{
        name: 'foo',
      }],
    })

    inner = await loader.create({
      name: '@cordisjs/plugin-group',
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
    await root.plugin(MockLoader)
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
      name: '@cordisjs/plugin-group',
      group: true,
      config: [],
    })

    beta = await loader.create({
      name: '@cordisjs/plugin-group',
      group: true,
      disabled: true,
      config: [],
    }, alpha)

    gamma = await loader.create({
      name: '@cordisjs/plugin-group',
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
})

describe('Group: awaited reconciliation', () => {
  const root = new Context()

  let loader!: MockLoader
  let foo!: Mock<Function>
  let bar!: Mock<Function>

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    foo = loader.mock('foo', () => {})
    bar = loader.mock('bar', () => {})
  })

  let group!: string

  it('initialize', async () => {
    group = await loader.create({
      name: '@cordisjs/plugin-group',
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
    await root.plugin(MockLoader)
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
      name: '@cordisjs/plugin-group',
      group: true,
      intercept: {
        foo: {
          a: 1,
        },
      },
      config: [],
    })

    inner = await loader.create({
      name: '@cordisjs/plugin-group',
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
