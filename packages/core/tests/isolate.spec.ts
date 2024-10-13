import { Context, Service, symbols } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'
import { event } from './utils'

describe('Isolation', () => {
  it('isolated context', async () => {
    const root = new Context()
    root.provide('foo')
    const ctx = root.isolate('foo')

    const outer = mock.fn()
    const inner = mock.fn()
    root.on('internal/service', outer)
    ctx.on('internal/service', inner)

    root.foo = { bar: 100 }
    expect(root.foo).to.have.property('bar', 100)
    expect(ctx.foo).to.be.not.ok
    expect(outer.mock.calls).to.have.length(1)
    expect(inner.mock.calls).to.have.length(0)

    ctx.foo = { bar: 200 }
    expect(root.foo).to.have.property('bar', 100)
    expect(ctx.foo).to.have.property('bar', 200)
    expect(outer.mock.calls).to.have.length(1)
    expect(inner.mock.calls).to.have.length(1)

    root.foo = null
    expect(root.foo).to.be.not.ok
    expect(ctx.foo).to.have.property('bar', 200)
    expect(outer.mock.calls).to.have.length(2)
    expect(inner.mock.calls).to.have.length(1)

    ctx.foo = null
    expect(root.foo).to.be.not.ok
    expect(ctx.foo).to.be.not.ok
    expect(outer.mock.calls).to.have.length(2)
    expect(inner.mock.calls).to.have.length(2)
  })

  it('isolated fork', () => {
    const root = new Context()
    root.provide('foo')
    const callback = mock.fn(() => {})
    const dispose = mock.fn(() => {})
    const plugin = {
      reusable: true,
      inject: ['foo'],
      apply: (ctx: Context) => {
        callback()
        ctx.on('dispose', dispose)
      },
    }

    const ctx1 = root.isolate('foo')
    ctx1.plugin(plugin)
    const ctx2 = root.isolate('foo')
    ctx2.plugin(plugin)
    expect(callback.mock.calls).to.have.length(0)

    root.foo = { bar: 100 }
    expect(callback.mock.calls).to.have.length(0)
    ctx1.foo = { bar: 200 }
    expect(callback.mock.calls).to.have.length(1)
    ctx2.foo = { bar: 300 }
    expect(callback.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('shared label', () => {
    const root = new Context()
    root.provide('foo')
    const callback = mock.fn(() => {})
    const dispose = mock.fn(() => {})
    const plugin = {
      reusable: true,
      inject: ['foo'],
      apply: (ctx: Context) => {
        callback()
        ctx.on('dispose', dispose)
      },
    }

    const label = Symbol('test')
    const ctx1 = root.isolate('foo', label)
    ctx1.plugin(plugin)
    const ctx2 = root.isolate('foo', label)
    ctx2.plugin(plugin)
    expect(callback.mock.calls).to.have.length(0)

    root.foo = { bar: 100 }
    expect(callback.mock.calls).to.have.length(0)
    ctx1.foo = { bar: 200 }
    expect(callback.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(0)
    ctx2.foo = null
    expect(dispose.mock.calls).to.have.length(2)
    ctx2.foo = { bar: 300 }
    expect(callback.mock.calls).to.have.length(4)
    expect(dispose.mock.calls).to.have.length(2)
    ctx1.foo = null
    expect(dispose.mock.calls).to.have.length(4)
  })

  it('isolated event', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }

      start() {
        this.ctx.emit(this, event)
      }
    }

    const root = new Context()
    const ctx = root.isolate('foo')
    const outer = mock.fn()
    const inner = mock.fn()
    root.on(event, outer)
    ctx.on(event, inner)
    ctx.plugin(Foo)

    expect(outer.mock.calls).to.have.length(0)
    expect(inner.mock.calls).to.have.length(1)
  })
})
