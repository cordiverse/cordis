import { Context, Service } from '../src'
import { describe, test } from 'node:test'
import { expect } from 'chai'
import {} from './utils'

describe('Association', () => {
  test('service injection', async () => {
    const root = new Context()

    class Foo extends Service {
      qux = 1
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
      }
    }

    class FooBar extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo.bar', true)
      }
    }

    root.plugin(Foo)
    const fork = root.plugin(FooBar)
    expect(root.foo).to.be.instanceof(Foo)
    expect(root.foo.bar).to.be.instanceof(FooBar)
    expect(root.foo.qux).to.equal(1)
    fork.dispose()
    expect(root.foo.bar).to.be.undefined
  })

  test('property injection', async () => {
    const root = new Context()

    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
      }
    }

    root.provide('foo.bar')
    root.plugin(Foo)
    expect(root.foo).to.be.instanceof(Foo)
    root.foo.qux = 2
    root.foo.bar = 3
    expect(root.foo.qux).to.equal(2)
    expect(root.foo.bar).to.equal(3)
    expect(root[`foo.qux`]).to.be.undefined
    expect(root[`foo.bar`]).to.equal(3)
  })

  test('associated type', async () => {
    interface Session {
      bar(): this
    }

    class Session {
      constructor(ctx: Context) {
        this[Context.current] = ctx
        return Context.associate(this, 'session')
      }
    }

    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
        ctx.provide('session.bar')
        ctx['session.bar'] = function (this: Session) {
          return this
        }
      }
    }

    const root = new Context()
    const session = new Session(root)
    root.plugin(Foo)
    expect(root.foo).to.be.instanceof(Foo)
    expect(session.bar()).to.be.instanceof(Session)
  })
})
