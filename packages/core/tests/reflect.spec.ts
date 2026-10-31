import { expect, describe, it } from 'vitest'
import { mock } from 'node:test'
import { types } from 'node:util'
import { Context } from '../src/index.ts'

describe('Reflect', () => {
  it('Context.is()', () => {
    class SubContext extends Context {}

    expect(Context.is(new SubContext())).to.equal(true)
  })

  it('access check', async () => {
    const root = new Context()

    await root.plugin((ctx) => {
      expect(() => ctx['prototype']).to.not.throw()
      expect(() => ctx.constructor).to.not.throw()
      expect(() => ctx.bar).to.throw('cannot get property "bar" without inject')
      expect(() => ctx.bar = 0).to.throw('cannot set property "bar" without provide')
    })

    await root.plugin((ctx) => {
      expect(() => ctx.foo = 0).to.throw('cannot set property "foo" without provide')
      expect(() => ctx.provide('foo')).to.not.throw()
      expect(() => ctx.provide('foo')).to.throw('service "foo" has been registered at <root>')
      expect(() => ctx.foo = 0).to.not.throw()
    })
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

      ctx.extend({ baz: 2 }).plugin((ctx) => {
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
})
