import { mock } from 'node:test'
import { expect } from 'chai'
import { Context, Service } from '@cordisjs/core'
import { defineProperty } from 'cosmokit'
import MockLoader from './utils'

describe('@cordisjs/loader', () => {
  const root = new Context()
  root.plugin(MockLoader)

  const foo = mock.fn((ctx: Context) => {
    ctx.accept()
  })
  const bar = mock.fn((ctx: Context) => {
    ctx.accept()
  })
  const qux = mock.fn((ctx: Context) => {
    ctx.accept()
  })
  root.loader.register('foo', foo)
  root.loader.register('bar', bar)
  root.loader.register('qux', qux)

  it('basic support', async () => {
    root.loader.config = [{
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
        disabled: true,
        name: 'qux',
      }],
    }]

    await root.start()
    expect(root.registry.get(foo)).to.be.ok
    expect(root.registry.get(foo)?.config).to.deep.equal({})
    expect(foo.mock.calls).to.have.length(1)
    expect(root.registry.get(bar)).to.be.ok
    expect(root.registry.get(bar)?.config).to.deep.equal({ a: 1 })
    expect(bar.mock.calls).to.have.length(1)
    expect(root.registry.get(qux)).to.be.not.ok
  })

  it('entry update', async () => {
    root.loader.config = [{
      id: '1',
      name: 'foo',
    }, {
      id: '4',
      name: 'qux',
    }]

    foo.mock.resetCalls()
    bar.mock.resetCalls()
    await root.loader.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.registry.get(foo)).to.be.ok
    expect(root.registry.get(bar)).to.be.not.ok
    expect(root.registry.get(qux)).to.be.ok
    expect(foo.mock.calls).to.have.length(0)
    expect(bar.mock.calls).to.have.length(0)
    expect(qux.mock.calls).to.have.length(1)
  })

  it('plugin update', async () => {
    const runtime = root.registry.get(foo)
    runtime!.update({ a: 3 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.loader.config).to.deep.equal([{
      id: '1',
      name: 'foo',
      config: { a: 3 },
    }, {
      id: '4',
      name: 'qux',
    }])
  })

  it('plugin dispose', async () => {
    const runtime = root.registry.get(foo)
    runtime!.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.loader.config).to.deep.equal([{
      id: '1',
      name: 'foo',
      disabled: true,
      config: { a: 3 },
    }, {
      id: '4',
      name: 'qux',
    }])
  })

  describe('service isolation', async () => {
    const root = new Context()
    root.plugin(MockLoader)

    const dispose = mock.fn()
    const foo = mock.fn((ctx: Context) => {
      ctx.on('dispose', dispose)
    })
    defineProperty(foo, 'inject', ['bar'])
    class Bar extends Service {
      static [Service.provide] = 'bar'
      static [Service.immediate] = true
    }
    class Qux extends Service {
      static [Service.provide] = 'qux'
      static [Service.immediate] = true
    }
    root.loader.register('foo', foo)
    root.loader.register('bar', Bar)
    root.loader.register('qux', Qux)

    it('basic support', async () => {
      root.loader.config = [{
        id: '1',
        name: 'bar',
      }, {
        id: '2',
        name: 'qux',
      }, {
        id: '3',
        name: 'cordis/group',
        config: [{
          id: '4',
          name: 'foo',
        }],
      }]

      await root.start()
      expect(root.registry.get(foo)).to.be.ok
      expect(root.registry.get(Bar)).to.be.ok
      expect(root.registry.get(Qux)).to.be.ok
      expect(foo.mock.calls).to.have.length(1)
    })

    it('isolate', async () => {
      root.loader.config = [{
        id: '1',
        name: 'bar',
      }, {
        id: '2',
        name: 'qux',
      }, {
        id: '3',
        name: 'cordis/group',
        isolate: {
          bar: true,
        },
        config: [{
          id: '4',
          name: 'foo',
        }],
      }]

      expect(dispose.mock.calls).to.have.length(0)
      await root.loader.start()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(foo.mock.calls).to.have.length(1)
      expect(dispose.mock.calls).to.have.length(1)

      root.loader.config = [{
        id: '1',
        name: 'bar',
      }, {
        id: '2',
        name: 'qux',
      }, {
        id: '3',
        name: 'cordis/group',
        isolate: {
          bar: false,
          qux: true,
        },
        config: [{
          id: '4',
          name: 'foo',
        }],
      }]

      await root.loader.start()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(foo.mock.calls).to.have.length(2)
      expect(dispose.mock.calls).to.have.length(1)
    })
  })
})
