import { expect } from 'chai'
import { mock } from 'node:test'
import { Context } from '../src'

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
    root.on('internal/warn', warn)
    root.mixin('foo', ['bar'])
    root.provide('foo')
    root.set('foo', { bar: 1 })

    // foo is a service
    expect(root.get('foo')).to.be.ok
    // bar is a mixin
    expect(root.get('bar')).to.be.undefined
    // root is a property
    expect(root.get('root')).to.be.undefined

    root.inject({ foo: { required: false } }, (ctx) => {
      warn.mock.resetCalls()
      expect(warn.mock.calls).to.have.length(0)

      ctx.extend({ baz: 2 }).plugin((ctx) => {
        warn.mock.resetCalls()
        expect(ctx.baz).to.equal(2)
        expect(warn.mock.calls).to.have.length(0)
      })
    })
  })

  it('service inject leak', async () => {
    const root = new Context()
    root.provide('foo')
    root.set('foo', { bar: 1 })
    const fiber1 = await root.inject({ foo: true }, () => {})
    const fiber2 = await root.inject({ foo: false }, () => {})
    expect(fiber1.ctx.foo).to.be.ok
    expect(fiber2.ctx.foo).to.be.ok
    await fiber1.dispose()
    await fiber2.dispose()
    expect(() => fiber1.ctx.foo).to.throw('cannot get required service "foo" in inactive context')
    expect(() => fiber2.ctx.foo).to.not.throw()
  })
})
