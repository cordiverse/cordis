import { expect } from 'chai'
import { Context } from '@cordisjs/core'
import MockLoader from './utils'

describe('basic support', () => {
  const root = new Context()
  root.plugin(MockLoader)
  const loader = root.loader

  const foo = loader.mock('foo', (ctx: Context) => ctx.accept())
  const bar = loader.mock('bar', (ctx: Context) => ctx.accept())
  const qux = loader.mock('qux', (ctx: Context) => ctx.accept())

  before(() => loader.start())

  it('loader initiate', async () => {
    loader.config = [{
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
    }]
    await loader.start()

    loader.expectEnable(foo, {})
    loader.expectEnable(bar, { a: 1 })
    loader.expectDisable(qux)
    expect(foo.mock.calls).to.have.length(1)
    expect(bar.mock.calls).to.have.length(1)
    expect(qux.mock.calls).to.have.length(0)
  })

  it('loader update', async () => {
    foo.mock.resetCalls()
    bar.mock.resetCalls()
    loader.config = [{
      id: '1',
      name: 'foo',
    }, {
      id: '4',
      name: 'qux',
    }]
    await loader.start()

    loader.expectEnable(foo, {})
    loader.expectDisable(bar)
    loader.expectEnable(qux, {})
    expect(foo.mock.calls).to.have.length(0)
    expect(bar.mock.calls).to.have.length(0)
    expect(qux.mock.calls).to.have.length(1)
  })

  it('plugin self-update 1', async () => {
    root.registry.get(foo)!.update({ a: 3 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(loader.config).to.deep.equal([{
      id: '1',
      name: 'foo',
      config: { a: 3 },
    }, {
      id: '4',
      name: 'qux',
    }])
  })

  it('plugin self-update 2', async () => {
    root.registry.get(foo)!.children[0].update({ a: 5 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(loader.config).to.deep.equal([{
      id: '1',
      name: 'foo',
      config: { a: 5 },
    }, {
      id: '4',
      name: 'qux',
    }])
  })

  it('plugin self-dispose 1', async () => {
    root.registry.get(foo)!.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(loader.config).to.deep.equal([{
      id: '1',
      name: 'foo',
      disabled: true,
      config: { a: 5 },
    }, {
      id: '4',
      name: 'qux',
    }])
  })

  it('plugin self-dispose 2', async () => {
    root.registry.get(qux)!.children[0].dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(loader.config).to.deep.equal([{
      id: '1',
      name: 'foo',
      disabled: true,
      config: { a: 5 },
    }, {
      id: '4',
      name: 'qux',
      disabled: true,
    }])
  })
})
