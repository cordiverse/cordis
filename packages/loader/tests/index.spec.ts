import { expect } from 'chai'
import { Context, FiberState } from '@cordisjs/core'
import MockLoader, { sleep } from './utils'
import { Mock } from 'node:test'

describe('Loader: basic support', () => {
  const root = new Context()

  let loader!: MockLoader
  let foo!: Mock<Function>
  let bar!: Mock<Function>
  let qux!: Mock<Function>

  before(async () => {
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
      name: 'cordis/group',
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
    expect(loader.file.data).to.deep.equal([{
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
    expect(loader.file.data).to.deep.equal([{
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

  before(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    loader.mock('foo', () => promise)
    Object.assign(loader.mock('bar', (ctx: Context) => ctx.on('internal/update', () => true)), {
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
