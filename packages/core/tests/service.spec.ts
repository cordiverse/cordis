import { Context, Service } from '../src'
import { defineProperty, noop } from 'cosmokit'
import { expect } from 'chai'
import { describe, mock, test } from 'node:test'
import { checkError, getHookSnapshot } from './utils'

describe('Service', () => {
  test('non-service access', async () => {
    const root = new Context()
    const warn = mock.fn()
    root.on('internal/warning', warn)

    root.plugin((ctx) => {
      // `$bar` is `$`-prefixed
      ctx['$bar']
      expect(warn.mock.calls).to.have.length(0)

      // `bar` is neither defined on context nor declared as injection
      ctx.bar
      expect(warn.mock.calls).to.have.length(1)

      // non-service can be unproxyable
      ctx.bar = new Set()
      expect(warn.mock.calls).to.have.length(1)

      // non-service can be accessed if defined on context
      ctx.bar.add(1)
      expect(warn.mock.calls).to.have.length(1)

      // non-service can be overwritten
      expect(() => ctx.bar = new Set()).to.not.throw()
    })

    await checkError(root)
  })

  test('service access', async () => {
    const root = new Context()
    const warn = mock.fn()
    root.on('internal/warning', warn)
    root.provide('foo')

    root.plugin((ctx) => {
      // service should be proxyable
      ctx.foo = new Set()
      expect(warn.mock.calls).to.have.length(1)

      // `foo` is not declared as injection
      ctx.foo.add(1)
      expect(warn.mock.calls).to.have.length(2)

      // service cannot be overwritten
      expect(() => ctx.foo = new Set()).to.throw()
    })

    await checkError(root)
  })

  test('service injection', async () => {
    const root = new Context()
    const warn = mock.fn()
    root.on('internal/warning', warn)
    root.alias('bar', ['baz'])
    root.mixin('foo', ['bar'])
    root.provide('foo')
    root.foo = { bar: 1 }

    // foo is a service
    expect(root.get('foo')).to.be.ok
    // bar is a mixin
    expect(root.get('bar')).to.be.undefined
    // root is a property
    expect(root.get('root')).to.be.undefined

    root.using({ optional: ['foo'] }, (ctx) => {
      warn.mock.resetCalls()
      ctx.baz = 2
      expect(warn.mock.calls).to.have.length(0)

      ctx.plugin((ctx) => {
        warn.mock.resetCalls()
        expect(ctx.baz).to.equal(2)
        expect(warn.mock.calls).to.have.length(0)
      })
    })

    await checkError(root)
  })

  test('normal service', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }
    }

    const root = new Context()
    root.plugin(Foo)
    expect(root.foo).to.be.undefined

    await root.start()
    expect(root.foo).to.be.instanceof(Foo)

    root.registry.delete(Foo)
    expect(root.foo).to.be.undefined
  })

  test('immediate service', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
      }
    }

    const root = new Context()
    const callback = mock.fn(noop)
    root.on('internal/service', callback)

    root.plugin(Foo)
    expect(root.foo).to.be.instanceof(Foo)
    expect(callback.mock.calls).to.have.length(1)

    await root.start()
    expect(callback.mock.calls).to.have.length(1)
  })

  test('Context.current', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
      }
    }

    const root = new Context()
    root.plugin(Foo)
    expect(root.foo[Context.current]).to.equal(root)

    const ctx = root.extend()
    expect(ctx.foo[Context.current]).to.equal(ctx)
  })

  test('dependency update', async () => {
    const callback = mock.fn((foo: any) => {})
    const dispose = mock.fn((foo: any) => {})
    const plugin = mock.fn((ctx: Context) => {
      ctx.on('ready', () => callback(ctx.foo))
      ctx.on('dispose', () => dispose(ctx.foo))
    })

    const root = new Context()
    await root.start()
    root.using(['foo'], plugin)

    expect(callback.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)

    const old = root.foo = { bar: 100 }
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments[0]).to.have.property('bar', 100)
    expect(dispose.mock.calls).to.have.length(0)

    // do not trigger event if reference has not changed
    old.bar = 200
    root.foo = old
    expect(callback.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)

    root.foo = null
    root.foo = { bar: 300 }
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls[1].arguments[0]).to.have.property('bar', 300)
    expect(dispose.mock.calls).to.have.length(1)
    expect(dispose.mock.calls[0].arguments[0]).to.have.property('bar', 200)

    root.foo = null
    expect(callback.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(2)
    expect(dispose.mock.calls[1].arguments[0]).to.have.property('bar', 300)
  })

  test('lifecycle methods', async () => {
    const start = mock.fn(noop)
    const stop = mock.fn(noop)
    const fork = mock.fn(noop)

    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }

      start = start
      stop = stop
      fork = fork
    }

    const root = new Context()
    root.plugin(Foo)
    expect(start.mock.calls).to.have.length(0)
    expect(stop.mock.calls).to.have.length(0)
    expect(fork.mock.calls).to.have.length(1)

    await root.start()
    expect(start.mock.calls).to.have.length(1)
    expect(stop.mock.calls).to.have.length(0)
    expect(fork.mock.calls).to.have.length(1)

    root.plugin(Foo)
    expect(start.mock.calls).to.have.length(1)
    expect(stop.mock.calls).to.have.length(0)
    expect(fork.mock.calls).to.have.length(2)

    root.registry.delete(Foo)
    expect(start.mock.calls).to.have.length(1)
    expect(stop.mock.calls).to.have.length(1)
    expect(fork.mock.calls).to.have.length(2)
  })

  // https://github.com/koishijs/koishi/issues/1110
  test('memory leak test', async () => {
    class Test extends Service {
      constructor(ctx: Context) {
        super(ctx, 'test', true)
        ctx.using(['test'], () => {})
      }
    }

    const root = new Context()
    const before = getHookSnapshot(root)
    root.plugin(Test)
    const after = getHookSnapshot(root)
    root.registry.delete(Test)
    expect(before).to.deep.equal(getHookSnapshot(root))
    root.plugin(Test)
    expect(after).to.deep.equal(getHookSnapshot(root))
  })

  // https://github.com/koishijs/koishi/issues/1130
  test('immediate + dependency', async () => {
    const foo = mock.fn(noop)
    const bar = mock.fn(noop)
    const qux = mock.fn(noop)

    class Foo extends Service {
      static inject = ['qux']
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
      }
      start = foo
    }

    class Bar extends Service {
      static inject = ['foo', 'qux']
      constructor(ctx: Context) {
        super(ctx, 'bar', true)
      }
      start = bar
    }

    class Qux extends Service {
      constructor(ctx: Context) {
        super(ctx, 'qux', true)
      }
      start = qux
    }

    const root = new Context()
    root.plugin(Foo)
    root.plugin(Bar)
    root.plugin(Qux)

    await root.start()
    expect(foo.mock.calls).to.have.length(1)
    expect(bar.mock.calls).to.have.length(1)
    expect(qux.mock.calls).to.have.length(1)
  })

  test('functional service', async () => {
    interface Config {}

    interface Foo {
      (init?: Config): Config
    }

    class Foo extends Service {
      constructor(ctx: Context, public config?: Config) {
        super(ctx, 'foo', true)
      }

      [Context.invoke](init?: Config) {
        const caller = this[Context.current]
        expect(caller).to.be.instanceof(Context)
        let result = { ...this.config }
        let intercept = caller[Context.intercept]
        while (intercept) {
          Object.assign(result, intercept.foo)
          intercept = Object.getPrototypeOf(intercept)
        }
        Object.assign(result, init)
        return result
      }

      reflect() {
        return this()
      }

      extend(config?: Config) {
        return this[Context.extend]({
          config: { ...this.config, ...config },
        })
      }
    }

    const root = new Context()
    root.plugin(Foo, { a: 1 })

    // access from context
    expect(root.foo()).to.deep.equal({ a: 1 })
    const ctx1 = root.intercept('foo', { b: 2 })
    expect(ctx1.foo()).to.deep.equal({ a: 1, b: 2 })
    const foo1 = ctx1.foo
    expect(foo1).to.be.instanceof(Foo)

    // create extension
    const foo2 = root.foo.extend({ c: 3 })
    expect(foo2).to.be.instanceof(Foo)
    expect(foo2()).to.deep.equal({ a: 1, c: 3 })
    const foo3 = foo1.extend({ d: 4 })
    expect(foo3).to.be.instanceof(Foo)
    expect(foo3.reflect()).to.deep.equal({ a: 1, b: 2, d: 4 })

    // context tracibility
    expect(foo1.reflect()).to.deep.equal({ a: 1, b: 2 })
  })
})
