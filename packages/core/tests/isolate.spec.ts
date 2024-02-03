import { Context, Service } from '../src'
import { expect } from 'chai'
import { describe, mock, test } from 'node:test'
import { event } from './utils'

describe('Isolation', () => {
  test('isolated context', async () => {
    const root = new Context()
    const ctx = root.isolate(['foo'])

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

  test('isolated fork', () => {
    const root = new Context()
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

    const ctx1 = root.isolate(['foo'])
    ctx1.plugin(plugin)
    const ctx2 = root.isolate(['foo'])
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

  test('shared service', () => {
    const root = new Context()
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

    const ctx1 = root.isolate(['foo'], 'test')
    ctx1.plugin(plugin)
    const ctx2 = root.isolate(['foo'], 'test')
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

  test('isolated event', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
      }

      start() {
        this.ctx.emit(this, event)
      }
    }

    const root = new Context()
    const ctx = root.isolate(['foo'])
    const outer = mock.fn()
    const inner = mock.fn()
    root.on(event, outer)
    ctx.on(event, inner)
    ctx.plugin(Foo)

    await ctx.start()
    expect(outer.mock.calls).to.have.length(0)
    expect(inner.mock.calls).to.have.length(1)
  })
})
