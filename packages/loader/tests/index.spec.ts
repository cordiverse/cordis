import { describe, mock, test } from 'node:test'
import { expect } from 'chai'
import { Context } from '@cordisjs/core'
import MockLoader from './utils'

describe('@cordisjs/loader', () => {
  const root = new Context()
  root.plugin(MockLoader)
  root.loader.writable = true

  test('loader.createApp()', async () => {
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

    const foo = mock.fn()
    const bar = mock.fn()
    root.loader.register('foo', foo)
    root.loader.register('bar', bar)

    await root.start()

    expect(root.registry.get(foo)).to.be.ok
    expect(root.registry.get(foo)?.config).to.deep.equal({})
    expect(root.registry.get(bar)).to.be.ok
    expect(root.registry.get(bar)?.config).to.deep.equal({ a: 1 })
  })
})
