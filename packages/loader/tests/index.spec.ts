import { expect, describe, it, beforeAll } from 'vitest'
import { Context, FiberState, Service } from 'cordis'
import { EntryChange, EntryTree } from '../src/index.ts'
import MockLoader, { sleep } from './utils.ts'
import { Mock, mock } from 'node:test'

describe('Loader: disabled js expression', () => {
  // `disabled: !!js <expr>` parses to an expression node, which is truthy as an
  // object — reading it as a value disables the entry whatever it says
  it('evaluates the expression instead of treating the node as truthy', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as any
    loader.mock('plug', () => {})

    const id = await loader.create({ id: 'a', name: 'plug', disabled: { __jsExpr: 'false' } })
    await sleep()
    expect(loader.store[id].disabled).to.equal(false)

    const id2 = await loader.create({ id: 'b', name: 'plug', disabled: { __jsExpr: 'true' } })
    await sleep()
    expect(loader.store[id2].disabled).to.equal(true)
  })
})

describe('Loader: basic support', () => {
  const root = new Context()

  let loader!: MockLoader
  let foo!: Mock<Function>
  let bar!: Mock<Function>
  let qux!: Mock<Function>

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    foo = loader.mock('foo', (ctx: Context) => ctx.on('internal/update', () => {}))
    bar = loader.mock('bar', (ctx: Context) => ctx.on('internal/update', () => {}))
    qux = loader.mock('qux', (ctx: Context) => ctx.on('internal/update', () => {}))
  })

  it('loader initiate', async () => {
    await loader.read([{
      id: '1',
      name: 'foo',
    }, {
      id: '2',
      name: '@cordisjs/plugin-group',
      config: [{
        id: '3',
        name: 'bar',
        config: {
          a: 1,
        },
      }, {
        id: '4',
        name: 'qux',
        disabled: true,
      }],
    }])

    loader.expectEnable(foo)
    loader.expectEnable(bar)
    loader.expectDisable(qux)
    expect(foo.mock.calls).to.have.length(1)
    expect(bar.mock.calls).to.have.length(1)
    expect(qux.mock.calls).to.have.length(0)
  })

  it('loader update', async () => {
    foo.mock.resetCalls()
    bar.mock.resetCalls()
    await loader.read([{
      id: '1',
      name: 'foo',
    }, {
      id: '4',
      name: 'qux',
    }])

    loader.expectEnable(foo)
    loader.expectDisable(bar)
    loader.expectEnable(qux)
    expect(foo.mock.calls).to.have.length(0)
    expect(bar.mock.calls).to.have.length(0)
    expect(qux.mock.calls).to.have.length(1)
  })

  it('plugin self-update', async () => {
    loader.expectFiber('1').update({ a: 3 })
    await sleep()
    expect(loader.data).to.deep.equal([{
      id: '1',
      name: 'foo',
      config: { a: 3 },
    }, {
      id: '4',
      name: 'qux',
    }])
  })

  it('plugin self-dispose', async () => {
    loader.expectFiber('1').dispose()
    await sleep()
    expect(loader.data).to.deep.equal([{
      id: '1',
      name: 'foo',
      disabled: true,
      config: { a: 3 },
    }, {
      id: '4',
      name: 'qux',
    }])
  })
})

describe('Loader: intercept config', () => {
  const root = new Context()

  let loader!: MockLoader
  let foo!: string
  let bar!: string
  let qux!: string

  const { promise, resolve } = Promise.withResolvers<void>()

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    loader.mock('foo', () => promise)
    Object.assign(loader.mock('bar', (ctx: Context) => ctx.on('internal/update', () => {})), {
      inject: ['never'],
    })
    loader.mock('qux', () => {})
  })

  it('pending', async () => {
    foo = await loader.create({
      name: 'foo',
    })
    bar = await loader.create({
      name: 'bar',
    })
    qux = await loader.create({
      name: 'qux',
      inject: {
        loader: true,
      },
      intercept: {
        loader: {
          await: true,
        },
      },
    })

    await sleep()
    expect(loader.expectFiber(foo).state).to.equal(FiberState.LOADING)
    expect(loader.expectFiber(bar).state).to.equal(FiberState.PENDING)
    expect(loader.expectFiber(qux).state).to.equal(FiberState.PENDING)
  })

  it('resolved', async () => {
    resolve()
    await sleep()
    expect(loader.expectFiber(foo).state).to.equal(FiberState.ACTIVE)
    expect(loader.expectFiber(bar).state).to.equal(FiberState.PENDING)
    expect(loader.expectFiber(qux).state).to.equal(FiberState.ACTIVE)
  })
})

// a failing entry is reported by the fiber itself; it must not escape as an
// unhandled rejection, which would take the whole process down with it
describe('Loader: entry failure', () => {
  const root = new Context()

  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    loader.mock('bad', () => {
      throw new Error('boom')
    })
    loader.mock('good', () => {})
  })

  it('on load', async () => {
    await loader.read([{
      id: '1',
      name: 'bad',
    }, {
      id: '2',
      name: 'good',
    }])

    expect(loader.expectFiber('1').state).to.equal(FiberState.FAILED)
    expect(loader.expectFiber('2').state).to.equal(FiberState.ACTIVE)
  })

  it('on config update', async () => {
    await loader.read([{
      id: '1',
      name: 'bad',
      config: { a: 1 },
    }, {
      id: '2',
      name: 'good',
    }])

    expect(loader.expectFiber('1').state).to.equal(FiberState.FAILED)
    expect(loader.expectFiber('2').state).to.equal(FiberState.ACTIVE)
  })

  it('on an id containing the separator', async () => {
    await loader.read([{
      id: '2',
      name: 'good',
    }, {
      id: '3:4',
      name: 'good',
    }])

    expect(loader.store['3:4']).to.be.undefined
    expect(loader.expectFiber('2').state).to.equal(FiberState.ACTIVE)
  })
})

// interpolated expressions read from the context, so they can only be
// evaluated once the entry's dependencies are ready
describe('Loader: config interpolation', () => {
  const root = new Context()

  let loader!: MockLoader
  let consumer!: Mock<Function>

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    loader.mock('provider', (ctx: Context, config: { value: number }) => {
      ctx.provide('foo', { value: config.value })
    })
    consumer = loader.mock('consumer', () => {})
  })

  it('wait for dependencies', async () => {
    await loader.read([{
      id: '1',
      name: 'consumer',
      inject: ['foo'],
      config: { value: { __jsExpr: 'foo.value' } },
    }])
    await sleep()

    expect(loader.expectFiber('1').state).to.equal(FiberState.PENDING)
    expect(consumer.mock.calls).to.have.length(0)
  })

  it('evaluate after dependencies are ready', async () => {
    await loader.read([{
      id: '1',
      name: 'consumer',
      inject: ['foo'],
      config: { value: { __jsExpr: 'foo.value' } },
    }, {
      id: '2',
      name: 'provider',
      config: { value: 1 },
    }])
    await sleep()

    expect(loader.expectFiber('1').state).to.equal(FiberState.ACTIVE)
    expect(consumer.mock.calls).to.have.length(1)
    expect(consumer.mock.calls[0].arguments[1]).to.deep.equal({ value: 1 })
  })

  it('re-evaluate when dependencies reload', async () => {
    await loader.update('2', { config: { value: 2 } })
    await sleep()

    expect(consumer.mock.calls).to.have.length(2)
    expect(consumer.mock.calls[1].arguments[1]).to.deep.equal({ value: 2 })
  })

  it('keep the source config unevaluated', () => {
    expect(loader.expectFiber('1').config).to.deep.equal({ value: { __jsExpr: 'foo.value' } })
  })
})

// a plugin created inside an entry inherits `entry` through the context
// prototype chain, but its config comes from code rather than the config file
describe('Loader: nested plugin config', () => {
  const root = new Context()

  let loader!: MockLoader
  let child!: Mock<Function>

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    child = loader.mock('child', () => {})
  })

  it('skip nested plugins', async () => {
    const config = { value: { __jsExpr: 'foo.value' } }
    loader.mock('parent', (ctx: Context) => {
      ctx.plugin(child, config)
    })

    await loader.read([{ id: '1', name: 'parent' }])
    await sleep()

    expect(child.mock.calls).to.have.length(1)
    // same reference: neither interpolated nor rebuilt
    expect(child.mock.calls[0].arguments[1]).to.equal(config)
  })
})

// resolution reads services through `fiber.committed`, which a failed fiber no
// longer has, so recovery must not depend on resolving the new config first
describe('Loader: failed entry recovery', () => {
  const root = new Context()

  let loader!: MockLoader
  let consumer!: Mock<Function>
  let fail = true

  beforeAll(async () => {
    await root.plugin(MockLoader)
    ;(root.logger as any).error = mock.fn()
    loader = root.loader as any

    loader.mock('provider', (ctx: Context) => {
      ctx.provide('foo', { value: 1 })
    })
    consumer = loader.mock('consumer', () => {
      if (fail) throw new Error('boom')
    })
  })

  it('fail with dependencies available', async () => {
    await loader.read([{
      id: '1',
      name: 'consumer',
      inject: ['foo'],
      config: { value: { __jsExpr: 'foo.value' } },
    }, {
      id: '2',
      name: 'provider',
    }])
    await sleep()

    expect(loader.expectFiber('1').state).to.equal(FiberState.FAILED)
    expect(loader.expectFiber('1').committed).to.equal(undefined)
  })

  it('recover through update', async () => {
    fail = false
    await loader.update('1', { config: { value: { __jsExpr: 'foo.value' }, fixed: true } })
    await sleep()

    expect(loader.expectFiber('1').state).to.equal(FiberState.ACTIVE)
    expect(consumer.mock.calls[1].arguments[1]).to.deep.equal({ value: 1, fixed: true })
  })
})

// persistence must not depend on whether the fiber can act on the update
describe('Loader: pending entry update', () => {
  const root = new Context()

  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    loader.mock('foo', () => {})
  })

  it('persist an update to a pending fiber', async () => {
    await loader.read([{ id: '1', name: 'foo', inject: ['never'] }])
    await sleep()
    expect(loader.expectFiber('1').state).to.equal(FiberState.PENDING)

    loader.expectFiber('1').update({ a: 3 })
    await sleep()

    expect(loader.data).to.deep.equal([{
      id: '1',
      name: 'foo',
      inject: ['never'],
      config: { a: 3 },
    }])
  })
})

// an entry disposed by the teardown of its parent has not disposed itself,
// even when the parent is still registered
describe('Loader: parent teardown', () => {
  const root = new Context()

  let loader!: MockLoader
  const changes: EntryChange[] = []

  class Tree extends EntryTree {
    static inject = ['foo']

    commit(change: EntryChange) {
      changes.push(change)
    }

    import(name: string) {
      return loader.import(name)
    }

    async* [Service.init]() {
      yield async () => {
        // the children are disposed before they are unregistered
        await sleep()
        this.root.stop()
      }
      await this.root.update([{ id: 'a', name: 'bar' }])
    }
  }

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    loader.mock('bar', () => {})
    loader.modules['tree'] = Tree as any
  })

  it('keep children enabled when the parent loses a dependency', async () => {
    const dispose = root.provide('foo', {})
    await loader.read([{ id: '1', name: 'tree' }])
    await sleep()
    expect(loader.expectFiber('1').state).to.equal(FiberState.ACTIVE)
    expect(loader.resolve('1:a').fiber?.state).to.equal(FiberState.ACTIVE)

    dispose()
    await loader.await()
    expect(loader.expectFiber('1').state).to.equal(FiberState.PENDING)
    expect(changes).to.deep.equal([])
  })
})
