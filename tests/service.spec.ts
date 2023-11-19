import { Context, Service } from '../src'
import { noop } from 'cosmokit'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import { checkError, getHookSnapshot } from './utils'

describe('Service', () => {
  it('non-service access', async () => {
    const root = new Context()
    const warn = jest.fn()
    root.on('internal/warning', warn)

    root.plugin((ctx) => {
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

  it('service access', async () => {
    const root = new Context()
    const warn = jest.fn()
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

  it('service injection', async () => {
    const root = new Context()
    const warn = jest.fn()
    root.on('internal/warning', warn)
    root.mixin('foo', ['bar'])
    root.provide('foo', { bar: 1 })

    // foo is a service
    expect(root.get('foo')).to.be.ok
    // bar is a mixin
    expect(root.get('bar')).to.be.undefined
    // root is a property
    expect(root.get('root')).to.be.undefined

    root.using({ optional: ['foo'] }, (ctx) => {
      warn.mockClear()
      ctx.bar = 2
      expect(warn.mock.calls).to.have.length(0)

      ctx.plugin((ctx) => {
        warn.mockClear()
        expect(ctx.bar).to.equal(2)
        expect(warn.mock.calls).to.have.length(0)
      })
    })

    await checkError(root)
  })

  it('normal service', async () => {
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

  it('immediate service', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
      }
    }

    const root = new Context()
    const callback = jest.fn(noop)
    root.on('internal/service', callback)

    root.plugin(Foo)
    expect(root.foo).to.be.instanceof(Foo)
    expect(callback.mock.calls).to.have.length(1)

    await root.start()
    expect(callback.mock.calls).to.have.length(1)
  })

  it('Context.current', async () => {
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

  it('dependency update', async () => {
    const callback = jest.fn((foo: any) => {})
    const dispose = jest.fn((foo: any) => {})
    const plugin = jest.fn((ctx: Context) => {
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
    expect(callback.mock.calls[0][0]).to.have.property('bar', 100)
    expect(dispose.mock.calls).to.have.length(0)

    // do not trigger event if reference has not changed
    old.bar = 200
    root.foo = old
    expect(callback.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)

    root.foo = null
    root.foo = { bar: 300 }
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls[1][0]).to.have.property('bar', 300)
    expect(dispose.mock.calls).to.have.length(1)
    expect(dispose.mock.calls[0][0]).to.have.property('bar', 200)

    root.foo = null
    expect(callback.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(2)
    expect(dispose.mock.calls[1][0]).to.have.property('bar', 300)
  })

  it('lifecycle methods', async () => {
    const start = jest.fn(noop)
    const stop = jest.fn(noop)
    const fork = jest.fn(noop)

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
  it('memory leak test', async () => {
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
  it('immediate + dependency', async () => {
    const foo = jest.fn(noop)
    const bar = jest.fn(noop)
    const qux = jest.fn(noop)

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
})
