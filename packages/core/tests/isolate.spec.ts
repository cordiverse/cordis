import { Context, Service } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'
import { allowRootAccess, event, sleep } from './utils'

describe('Isolation', () => {
  it('isolated context', async () => {
    const root = new Context()
    await root.plugin(allowRootAccess)
    const callback = mock.fn(() => {})
    const dispose = mock.fn(() => {})
    const plugin = {
      inject: ['foo'],
      apply: (ctx: Context) => {
        callback()
        return dispose
      },
    }

    await root.plugin(plugin)
    const ctx1 = root.isolate('foo')
    await ctx1.plugin(plugin)
    const ctx2 = root.isolate('foo')
    await ctx2.plugin(plugin)

    const dispose0 = root.provide('foo', { bar: 100 })
    expect(root.foo).to.have.property('bar', 100)
    expect(ctx1.foo).to.be.undefined
    expect(ctx2.foo).to.be.undefined
    await sleep()
    expect(callback.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)

    const dispose1 = ctx1.provide('foo', { bar: 200 })
    expect(root.foo).to.have.property('bar', 100)
    expect(ctx1.foo).to.have.property('bar', 200)
    expect(ctx2.foo).to.be.undefined
    await sleep()
    expect(callback.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(0)

    dispose0()
    expect(root.foo).to.be.undefined
    expect(ctx1.foo).to.have.property('bar', 200)
    expect(ctx2.foo).to.be.undefined
    await sleep()
    expect(callback.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(1)

    const dispose2 = ctx2.provide('foo', { bar: 300 })
    expect(root.foo).to.be.undefined
    expect(ctx1.foo).to.have.property('bar', 200)
    expect(ctx2.foo).to.have.property('bar', 300)
    await sleep()
    expect(callback.mock.calls).to.have.length(3)
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('shared label', async () => {
    const root = new Context()
    const callback = mock.fn(() => {})
    const dispose = mock.fn(() => {})
    const plugin = {
      inject: ['foo'],
      apply: (ctx: Context) => {
        callback()
        return dispose
      },
    }

    const label = Symbol('test')
    await root.plugin(plugin)
    const ctx1 = root.isolate('foo', label)
    await ctx1.plugin(plugin)
    const ctx2 = root.isolate('foo', label)
    await ctx2.plugin(plugin)
    await sleep()
    expect(callback.mock.calls).to.have.length(0)

    const dispose0 = root.provide('foo', { bar: 100 })
    expect(root.foo).to.have.property('bar', 100)
    expect(ctx1.foo).to.be.undefined
    expect(ctx2.foo).to.be.undefined
    await sleep()
    expect(callback.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)

    const dispose12 = ctx1.provide('foo', { bar: 200 })
    expect(root.foo).to.have.property('bar', 100)
    expect(ctx1.foo).to.have.property('bar', 200)
    expect(ctx2.foo).to.have.property('bar', 200)
    await sleep()
    expect(callback.mock.calls).to.have.length(3)
    expect(dispose.mock.calls).to.have.length(0)
    
    dispose12()
    expect(root.foo).to.have.property('bar', 100)
    expect(ctx1.foo).to.be.undefined
    expect(ctx2.foo).to.be.undefined
    await sleep()
    expect(callback.mock.calls).to.have.length(3)
    expect(dispose.mock.calls).to.have.length(2)
  })

  it('isolated event', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
        this.ctx.emit(this, event)
      }
    }

    const root = new Context()
    const ctx = root.isolate('foo')
    const outer = mock.fn()
    const inner = mock.fn()
    root.on(event, outer)
    ctx.on(event, inner)
    await ctx.plugin(Foo)

    expect(outer.mock.calls).to.have.length(0)
    expect(inner.mock.calls).to.have.length(1)
  })
})
