import { expect } from 'chai'
import { Context } from '@cordisjs/core'
import MockLoader, { sleep } from './utils'
import { Mock } from 'node:test'

describe('loader: basic support', () => {
  const root = new Context()

  let loader!: MockLoader
  let foo!: Mock<Function>
  let bar!: Mock<Function>
  let qux!: Mock<Function>

  before(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    foo = loader.mock('foo', (ctx: Context) => ctx.on('internal/update', () => true))
    bar = loader.mock('bar', (ctx: Context) => ctx.on('internal/update', () => true))
    qux = loader.mock('qux', (ctx: Context) => ctx.on('internal/update', () => true))
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
