import { Context, Service } from '../src'
import { expect } from 'chai'
import {} from './utils'

describe('Association', () => {
  it('service injection', async () => {
    const root = new Context()

    class Foo extends Service {
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
    fork.dispose()
    expect(root.foo.bar).to.be.undefined
  })

  it('associated type', async () => {
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
        ctx.root.provide('session.bar', function (this: Session) {
          return this
        })
      }
    }

    const root = new Context()
    const session = new Session(root)
    root.plugin(Foo)
    expect(root.foo).to.be.instanceof(Foo)
    expect(session.bar()).to.be.instanceof(Session)
  })
})
