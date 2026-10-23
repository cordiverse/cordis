import { Context, Service } from '../src/index.ts'
import { expect, describe, it } from 'vitest'
import { mock } from 'node:test'
import { event, sleep } from './utils.ts'

describe('Isolation', () => {
  it('does not expose own provisions across isolation boundaries', async () => {
    const root = new Context()
    await root.plugin(async (ctx) => {
      const isolated = ctx.isolate('foo')
      isolated.provide('foo', {})
      expect(isolated.foo).to.be.ok
      expect(() => ctx.foo).to.throw('cannot get property "foo" without inject')
      await isolated.plugin((ctx) => {
        expect(ctx.foo).to.be.ok
      })
      await ctx.plugin((ctx) => {
        expect(() => ctx.foo).to.throw('cannot get property "foo" without inject')
      })
    })
    await root.fiber.dispose()
  })

  it('does not inherit the injected view across isolation boundaries', async () => {
    const root = new Context()
    root.provide('foo', { value: 'outer' })
    const access = (ctx: Context) => {
      try {
        return ctx.foo.value
      } catch (error: any) {
        return error.message
      }
    }
    const results: string[] = []
    await root.inject(['foo'], async (ctx) => {
      await ctx.plugin((ctx) => {
        results.push(access(ctx))
      })
      await ctx.isolate('foo').plugin((ctx) => {
        results.push(access(ctx))
      })
      // pinning the same realm still derives an isolation of its own
      await ctx.isolate('foo', ctx[Context.isolate].foo).plugin((ctx) => {
        results.push(access(ctx))
      })
    })
    expect(results).to.deep.equal([
      'outer',
      'cannot get property "foo" without inject',
      'cannot get property "foo" without inject',
    ])
    await root.fiber.dispose()
  })

  it('isolated context', async () => {
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

  it('keeps own provisions separate from the injected view', async () => {
    const root = new Context()
    root.provide('foo', { value: 'outer' })
    const fiber = await root.inject(['foo'], async (ctx) => {
      const first = ctx.isolate('foo')
      const second = ctx.isolate('foo')
      const withdraw = first.provide('foo', { value: 'first' })
      second.provide('foo', { value: 'second' })

      expect(ctx.foo.value).to.equal('outer')
      expect(first.foo.value).to.equal('first')
      expect(second.foo.value).to.equal('second')
      await first.plugin((ctx) => {
        expect(ctx.foo.value).to.equal('first')
      })
      await second.plugin((ctx) => {
        expect(ctx.foo.value).to.equal('second')
      })

      await withdraw()
      expect(ctx.foo.value).to.equal('outer')
      expect(() => first.foo).to.throw('cannot get property "foo" without inject')
      expect(second.foo.value).to.equal('second')
      return () => {
        expect(ctx.foo.value).to.equal('outer')
      }
    })
    await fiber.dispose()
    expect(root.logger.buffer.filter(message => message.type === 'error')).to.have.length(0)
    await root.fiber.dispose()
  })
})
