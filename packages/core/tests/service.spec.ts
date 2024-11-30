import { Context, Service } from '../src'
import { noop } from 'cosmokit'
import { expect } from 'chai'
import { mock } from 'node:test'
import { Counter, getHookSnapshot, sleep } from './utils'

describe('Service', () => {
  it('non-service access', async () => {
    const root = new Context()
    const warn = mock.fn()
    root.on('internal/warning', warn)

    await root.plugin((ctx) => {
      // `$bar` is `$`-prefixed
      expect(() => ctx['$bar']).to.not.throw()

      // `bar` is neither defined on context nor declared as injection
      expect(() => ctx.bar).to.throw()

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
    root.on('internal/warning', warn)
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
    root.on('internal/warning', warn)
    root.alias('bar', ['baz'])
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

  it('normal service', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }

      async start() {
        await new Promise<void>((resolve, reject) => {
          this.ctx.on('custom-event', resolve)
        })
      }
    }

    const root = new Context()

    const callback = mock.fn(noop)
    root.inject(['foo'], callback)
    expect(callback.mock.calls).to.have.length(0)

    root.plugin(Foo)
    await sleep()
    expect(callback.mock.calls).to.have.length(0)

    root.emit('custom-event')
    await sleep()
    expect(callback.mock.calls).to.have.length(1)
  })

  it('immediate service', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }
    }

    const root = new Context()
    const callback = mock.fn(noop)
    root.inject(['foo'], callback)
    expect(callback.mock.calls).to.have.length(0)

    root.plugin(Foo)
    await sleep()
    expect(callback.mock.calls).to.have.length(1)
  })

  it('traceable effect (with inject)', async () => {
    class Foo extends Service {
      static inject = ['counter']

      constructor(ctx: Context) {
        super(ctx, 'foo')
      }

      get value() {
        return this.ctx.counter.value
      }

      increase() {
        return this.ctx.counter.increase()
      }
    }

    const root = new Context()
    const warning = mock.fn()
    root.on('internal/warning', warning)
    root.set('counter', new Counter(root))

    root.plugin(Foo)
    await sleep()
    root.foo.increase()
    expect(root.foo.value).to.equal(1)
    expect(warning.mock.calls).to.have.length(0)

    const fork = root.inject(['foo'], (ctx) => {
      root.foo.increase()
      expect(ctx.foo.value).to.equal(2)
      expect(warning.mock.calls).to.have.length(0)
    })

    fork.dispose()
    root.foo.increase()
    expect(root.foo.value).to.equal(3)
    expect(warning.mock.calls).to.have.length(0)
  })

  it('traceable effect (without inject)', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }

      get value() {
        return this.ctx.counter.value
      }

      increase() {
        return this.ctx.counter.increase()
      }
    }

    const root = new Context()
    root.set('counter', new Counter(root))

    root.plugin(Foo)
    await sleep()
    root.foo.increase()
    expect(root.foo.value).to.equal(1)

    const fork = root.inject(['foo'], (ctx) => {
      root.foo.increase()
      expect(root.foo.value).to.equal(2)
    })

    fork.dispose()
    root.foo.increase()
    expect(root.foo.value).to.equal(3)
  })

  it('dependency update', async () => {
    const callback = mock.fn((foo: any) => {})
    const dispose = mock.fn((foo: any) => {})
    const plugin = mock.fn((ctx: Context) => {
      callback(ctx.foo)
      ctx.on('dispose', () => dispose(ctx.foo))
    })

    const root = new Context()
    root.provide('foo')
    root.inject(['foo'], plugin)

    expect(callback.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)

    const old = { bar: 100 }
    root.set('foo', old)
    await sleep()
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments[0]).to.have.property('bar', 100)
    expect(dispose.mock.calls).to.have.length(0)

    // do not trigger event if reference has not changed
    old.bar = 200
    root.set('foo', old)
    await sleep()
    expect(callback.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)

    root.set('foo', null)
    root.set('foo', { bar: 300 })
    await sleep()
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls[1].arguments[0]).to.have.property('bar', 300)
    expect(dispose.mock.calls).to.have.length(1)
    expect(dispose.mock.calls[0].arguments[0]).to.have.property('bar', 200)

    root.set('foo', null)
    await sleep()
    expect(callback.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(2)
    expect(dispose.mock.calls[1].arguments[0]).to.have.property('bar', 300)
  })

  it('lifecycle methods', async () => {
    const start = mock.fn(noop)
    const stop = mock.fn(noop)

    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }

      start = start
      stop = stop
    }

    const root = new Context()
    root.isolate('foo').plugin(Foo)
    expect(start.mock.calls).to.have.length(1)
    expect(stop.mock.calls).to.have.length(0)

    root.isolate('foo').plugin(Foo)
    expect(start.mock.calls).to.have.length(2)
    expect(stop.mock.calls).to.have.length(0)

    root.registry.delete(Foo)
    await sleep()
    expect(start.mock.calls).to.have.length(2)
    expect(stop.mock.calls).to.have.length(2)
  })

  // https://github.com/koishijs/koishi/issues/1110
  it('memory leak test', async () => {
    class Test extends Service {
      constructor(ctx: Context) {
        super(ctx, 'test')
        ctx.inject(['test'], () => {})
      }
    }

    const root = new Context()
    const before = getHookSnapshot(root)
    root.plugin(Test)
    const after = getHookSnapshot(root)
    root.registry.delete(Test)
    await sleep()
    expect(before).to.deep.equal(getHookSnapshot(root))
    root.plugin(Test)
    expect(after).to.deep.equal(getHookSnapshot(root))
  })

  // https://github.com/koishijs/koishi/issues/1130
  it('immediate + dependency', async () => {
    const foo = mock.fn(noop)
    const bar = mock.fn(noop)
    const qux = mock.fn(noop)

    class Foo extends Service {
      static inject = ['qux']
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }
      start = foo
    }

    class Bar extends Service {
      static inject = ['foo', 'qux']
      constructor(ctx: Context) {
        super(ctx, 'bar')
      }
      start = bar
    }

    class Qux extends Service {
      constructor(ctx: Context) {
        super(ctx, 'qux')
      }
      start = qux
    }

    const root = new Context()
    root.plugin(Foo)
    root.plugin(Bar)
    root.plugin(Qux)

    await sleep()
    expect(foo.mock.calls).to.have.length(1)
    expect(bar.mock.calls).to.have.length(1)
    expect(qux.mock.calls).to.have.length(1)
  })
})
