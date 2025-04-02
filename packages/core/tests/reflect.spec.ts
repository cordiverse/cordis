import { expect } from 'chai'
import { mock } from 'node:test'
import { Context } from '../src'

describe('Reflect', () => {
  it('Context.is()', () => {
    class SubContext extends Context {}

    expect(Context.is(new SubContext())).to.equal(true)
  })

  it('non-service access', async () => {
    const root = new Context()
    const warn = mock.fn()
    root.on('internal/warn', warn)

    await root.plugin((ctx) => {
      // `bar` is neither defined on context nor declared as injection
      expect(() => ctx.bar).to.throw('cannot get property "bar" without inject')

      // reserved word
      expect(() => ctx['prototype']).to.not.throw()

      // non-service can be unproxyable
      expect(() => ctx.bar = new Set()).to.not.throw()

      // non-service can be accessed if defined on context
      expect(() => ctx.bar.add(1)).to.not.throw()

      // non-service can be overwritten
      expect(() => ctx.bar = new Set()).to.not.throw()
    })
  })

  it('service access', async () => {
    const root = new Context()
    const warn = mock.fn()
    root.on('internal/warn', warn)
    root.provide('foo')

    await root.plugin((ctx) => {
      // direct assignment is not recommended
      // ctx.foo = undefined
      // expect(warn.mock.calls).to.have.length(1)

      // service should be proxyable
      ctx.set('foo', new Set())
      expect(warn.mock.calls).to.have.length(1) // 2

      // `foo` is not declared as injection
      ctx.foo.add(1)

      // service cannot be overwritten
      expect(() => ctx.foo = new Set()).to.throw()
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
      ctx.baz = 2
      expect(warn.mock.calls).to.have.length(0)

      ctx.plugin((ctx) => {
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
