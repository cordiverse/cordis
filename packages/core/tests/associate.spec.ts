import { Context, Service } from '../src'
import { expect } from 'chai'

describe('Association', () => {
  it('service injection', async () => {
    const root = new Context()

    class Foo extends Service {
      qux = 1
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }
    }

    class FooBar extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo.bar')
      }
    }

    await root.plugin(Foo)
    const fiber = await root.plugin(FooBar)
    expect(root.foo).to.be.instanceof(Foo)
    expect(root.foo.bar).to.be.instanceof(FooBar)
    expect(root.foo.qux).to.equal(1)
    await fiber.dispose()
    expect(root.foo.bar).to.be.undefined
  })

  it('property injection', async () => {
    const root = new Context()

    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }
    }

    root.provide('foo.bar')
    root.provide('foo.baz')
    await root.plugin(Foo)
    expect(root.foo).to.be.instanceof(Foo)
    root.foo.qux = 2
    root.foo.bar = 3
    root.foo.baz = function () {
      return this
    }

    await root.inject(['foo'], (ctx) => {
      expect(ctx.foo.qux).to.equal(2)
      expect(ctx.foo.bar).to.equal(3)
      expect(() => ctx[`foo.qux`]).to.throw('cannot get property "foo.qux" without inject')
      expect(ctx[`foo.bar`]).to.equal(3)
      expect(ctx.foo.baz()).to.be.instanceof(Foo)
    })
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
        super(ctx, 'foo')
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
        super(ctx, 'bar')
        ctx.mixin('bar', {
          answer: 'session.answer',
        })
      }

      answer() {
        return 42
      }
    }

    const root = new Context()
    await root.plugin(Foo)

    await root.inject(['foo'], async (ctx) => {
      const session = ctx.foo.createSession()
      expect(session).to.be.instanceof(Session)
      expect(session.bar).to.be.undefined

      await ctx.plugin(Bar)
      await ctx.inject(['bar'], (ctx) => {
        const session = ctx.foo.createSession()
        expect(session).to.be.instanceof(Session)
        expect(session.answer()).to.equal(42)
      })
    })
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
        super(ctx, 'foo')
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
    await root.plugin(Foo)
    await root.plugin(Bar)

    await root.inject(['foo'], async (ctx) => {
      const session = ctx.foo.session()
      expect(session).to.be.instanceof(Session)
      expect(() => session.bar).to.throw()

      await ctx.inject(['bar'], (ctx) => {
        const session = ctx.foo.session()
        expect(session.bar).to.be.undefined
        session.bar = 100
        expect(session.bar).to.equal(101)
      })
    })
  })

  // https://github.com/cordiverse/cordis/issues/14
  it('inspect', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }

      bar(arg: any) {
        expect(arg.toString()).to.include('class X')
        this.baz(arg)
      }

      baz(arg: any) {
        expect(arg.toString()).to.include('class X')
      }
    }

    const root = new Context()
    await root.plugin(Foo)
    class X {}
    root.foo.bar(X)
  })
})
