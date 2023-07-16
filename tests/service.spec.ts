import { Context, Service } from '../src'
import { noop } from 'cosmokit'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import './utils'

describe('Service', () => {
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
    expect(root.foo).to.be.instanceOf(Foo)

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
    expect(root.foo).to.be.instanceOf(Foo)
    expect(callback.mock.calls).to.have.length(1)

    await root.start()
    expect(callback.mock.calls).to.have.length(1)
  })

  it('service caller', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
      }
    }

    const root = new Context()
    root.plugin(Foo)
    expect(root.foo.caller).to.equal(root)

    const ctx = root.extend()
    expect(ctx.foo.caller).to.equal(ctx)
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

  // https://github.com/koishijs/koishi/issues/1130
  it('immediate + dependency', async () => {
    const foo = jest.fn(noop)
    const bar = jest.fn(noop)
    const qux = jest.fn(noop)

    class Foo extends Service {
      static using = ['qux']
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
      }
      start = foo
    }

    class Bar extends Service {
      static using = ['foo', 'qux']
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
