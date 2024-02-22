import { describe, mock, test } from 'node:test'
import { expect } from 'chai'
import { Context } from '@cordisjs/core'
import MockLoader from './utils'

describe('@cordisjs/loader', () => {
  const root = new Context()
  root.plugin(MockLoader)
  root.loader.writable = true

  const foo = mock.fn((ctx: Context) => {
    ctx.accept()
  })
  const bar = mock.fn((ctx: Context) => {
    ctx.accept()
  })
  root.loader.register('foo', foo)
  root.loader.register('bar', bar)

  test('basic support', async () => {
    root.loader.config = [{
      id: '1',
      name: 'foo',
    }, {
      id: '2',
      name: 'group',
      config: [{
        id: '3',
        name: 'bar',
        config: {
          a: 1,
        },
      }],
    }]

    await root.start()
    expect(root.registry.get(foo)).to.be.ok
    expect(root.registry.get(foo)?.config).to.deep.equal({})
    expect(foo.mock.calls).to.have.length(1)
    expect(root.registry.get(bar)).to.be.ok
    expect(root.registry.get(bar)?.config).to.deep.equal({ a: 1 })
    expect(bar.mock.calls).to.have.length(1)
  })

  test('entry update', async () => {
    root.loader.config = [{
      id: '1',
      name: 'foo',
    }]

    root.loader.entryFork.update(root.loader.config)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.registry.get(foo)).to.be.ok
    expect(root.registry.get(bar)).to.be.not.ok
    expect(foo.mock.calls).to.have.length(1)
    expect(bar.mock.calls).to.have.length(1)
  })

  test('plugin update', async () => {
    const runtime = root.registry.get(foo)
    runtime!.update({ a: 3 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.loader.config).to.deep.equal([{
      id: '1',
      name: 'foo',
      config: { a: 3 },
    }])
  })

  test('plugin dispose', async () => {
    const runtime = root.registry.get(foo)
    runtime!.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.loader.config).to.deep.equal([{
      id: '1',
      name: 'foo',
      disabled: true,
      config: { a: 3 },
    }])
  })
})
