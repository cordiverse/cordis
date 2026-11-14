import { expect, describe, it } from 'vitest'
import { mock } from 'node:test'
import { types } from 'node:util'
import { Context, FiberState, Service } from '../src/index.ts'

describe('Reflect', () => {
  it('Context.is()', () => {
    class SubContext extends Context {}

    expect(Context.is(new SubContext())).to.equal(true)
  })

  it('access check', async () => {
    const root = new Context()

    await root.use((ctx) => {
      expect(() => ctx['prototype']).to.not.throw()
      expect(() => ctx.constructor).to.not.throw()
      expect(() => ctx.bar).to.throw('cannot get property "bar" without inject')
      expect(() => ctx.bar = 0).to.throw('cannot set property "bar" without provide')
    })

    await root.use((ctx) => {
      expect(() => ctx.foo = 0).to.throw('cannot set property "foo" without provide')
      expect(() => ctx.provide('foo')).to.not.throw()
      expect(() => ctx.provide('foo')).to.throw('service "foo" has been registered at <root>')
      expect(() => ctx.foo = 0).to.not.throw()
    })
  })

  // `this.ctx` hands out a shadow per access and drops it when the call returns.
  // The exemption for the root (`!runtime`) also matched a shadow, which has no
  // runtime either, so the write below used to report success and lose the value.
  it('a write through a service\'s own ctx is refused, not lost', async () => {
    class Counter {
      [Service.tracker] = { property: 'ctx' }
      count = 0
      constructor(public ctx: Context) {}
      declare(v: string) {
        (this.ctx as any).undeclared = v
      }
    }

    const root = new Context()
    const counter = new Counter(root)
    root.provide('counter', counter)

    // a field on the service keeps its value
    ;(root['counter'] as any).count = 42
    expect(counter.count).to.equal(42)

    // the root keeps its own properties
    ;(root as any).own = 'kept'
    expect((root as any).own).to.equal('kept')

    // a shadow is thrown away, so the write must not pretend to work
    expect(() => (root['counter'] as any).declare('lost')).to.throw(
      'cannot set property "undeclared" without provide')
    expect((root as any).undeclared).to.equal(undefined)
  })

  it('service injection', async () => {
    const root = new Context()
    const warn = mock.fn()
    ;(root.logger as any).warn = warn
    root.mixin('foo', ['bar'])
    root.provide('foo')
    root.set('foo', { bar: 1 })

    // foo is a service
    expect(root.get('foo')).to.be.ok
    // bar is a mixin
    expect(root.get('bar')).to.be.undefined
    // baseUrl is a property
    expect(root.get('baseUrl')).to.be.undefined

    root.inject(['foo'], (ctx) => {
      warn.mock.resetCalls()
      expect(warn.mock.calls).to.have.length(0)

      ctx.extend({ baz: 2 }).use((ctx) => {
        warn.mock.resetCalls()
        expect(ctx.baz).to.equal(2)
        expect(warn.mock.calls).to.have.length(0)
      })
    })
  })

  it('access error', async () => {
    const root = new Context()
    root.provide('foo')
    root.set('foo', { bar: 1 })

    function capture(callback: () => void) {
      try {
        callback()
      } catch (error) {
        return error as Error
      }
      throw new Error('expected an access error')
    }

    function getBar(ctx: Context) {
      return ctx.bar
    }

    function setBar(ctx: Context) {
      ctx.bar = 0
    }

    const fiber = await root.inject(['foo'], (ctx) => {
      for (const [name, callback] of [['getBar', getBar], ['setBar', setBar]] as const) {
        const error = capture(() => callback(ctx))
        expect(types.isNativeError(error)).to.equal(true)
        expect(error.stack!.split('\n')[1]).to.match(new RegExp(`^\\s+at ${name} `))
      }
    })
    await fiber.dispose()

    function getFoo() {
      return fiber.ctx.foo
    }

    const error = capture(getFoo)
    expect(types.isNativeError(error)).to.equal(true)
    expect(error.message).to.equal('cannot get required service "foo" in inactive context')
    expect(error.stack!.split('\n')[1]).to.match(/^\s+at getFoo /)
  })

  it('service inject leak', async () => {
    const root = new Context()
    root.provide('foo')
    root.set('foo', { bar: 1 })
    const fiber = await root.inject(['foo'], () => {})
    expect(fiber.ctx.foo).to.be.ok
    await fiber.dispose()
    expect(() => fiber.ctx.foo).to.throw('cannot get required service "foo" in inactive context')
  })

  it('does not load a fiber disposed during service notification', async () => {
    const root = new Context()
    const apply = mock.fn((ctx: Context, config: { id: number }) => {})
    const component = { inject: ['foo'], apply }
    const fiber1 = root.use(component, { id: 1 })
    const fiber2 = root.use(component, { id: 2 })
    root.on('internal/status', (fiber) => {
      if (fiber === Object.getPrototypeOf(fiber1) && fiber.state === FiberState.LOADING) {
        fiber2.dispose()
      }
    })

    root.provide('foo', {})
    await fiber1
    expect(apply.mock.calls.map(call => call.arguments[1].id)).to.deep.equal([1])
    expect(fiber2.state).to.equal(FiberState.DISPOSED)
    await root.fiber.dispose()
  })
})
