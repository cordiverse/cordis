import { Context, Service } from '../src'
import { expect } from 'chai'
import { checkError } from './utils'

describe('Association', () => {
  it('service injection', async () => {
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

  it('property injection', async () => {
    const root = new Context()

    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
      }
    }

    root.provide('foo.bar')
    root.provide('foo.baz')
    root.plugin(Foo)
    expect(root.foo).to.be.instanceof(Foo)
    root.foo.qux = 2
    root.foo.bar = 3
    expect(root.foo.qux).to.equal(2)
    expect(root.foo.bar).to.equal(3)
    expect(root[`foo.qux`]).to.be.undefined
    expect(root[`foo.bar`]).to.equal(3)

    root.foo.baz = function () {
      return this
    }
    expect(root.foo.baz()).to.be.instanceof(Foo)
  })

  it('associated type - service injection', async () => {
    class Session {
      [Service.tracker] = {
        property: 'ctx',
        associate: 'session',
      }

      constructor(public ctx: Context) {}
    }

    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
      }

      createSession() {
        return new Session(this.ctx)
      }
    }

    interface Session {
      bar(): this
    }

    class Bar extends Service {
      inject = ['foo']

      constructor(ctx: Context) {
        super(ctx, 'bar', true)
        ctx.mixin('bar', {
          getBar: 'session.bar',
        })
      }

      getBar(this: Session) {
        return this
      }
    }

    const root = new Context()
    root.plugin(Foo)

    root.inject(['foo'], (ctx) => {
      const session = ctx.foo.createSession()
      expect(session).to.be.instanceof(Session)
      expect(session.bar).to.be.undefined

      ctx.plugin(Bar)
      ctx.inject(['bar'], (ctx) => {
        const session = ctx.foo.createSession()
        expect(session).to.be.instanceof(Session)
        expect(session.bar()).to.be.instanceof(Bar)
      })
    })

    await checkError(root)
  })

  it('associated type - accessor injection', async () => {
    class Session {
      [Service.tracker] = {
        property: 'ctx',
        associate: 'session',
      }

      constructor(public ctx: Context) {}
    }

    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
      }

      session() {
        return new Session(this.ctx)
      }
    }

    interface Session {
      bar: number
    }

    interface Bar extends Session {
      secret: number
    }

    class Bar {
      constructor(ctx: Context) {
        ctx.mixin(this, {
          bar: 'session.bar',
        })
      }

      get bar() {
        return this.secret
      }

      set bar(value: number) {
        this.secret = value + 1
      }
    }

    const root = new Context()
    root.plugin(Foo)
    root.plugin(Bar)

    root.inject(['foo'], (ctx) => {
      const session = ctx.foo.session()
      expect(session).to.be.instanceof(Session)
      expect(session.bar).to.be.undefined

      session.bar = 100
      expect(session.bar).to.equal(101)
    })

    await checkError(root)
  })
})
