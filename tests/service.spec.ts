import { App, Context, Plugin, Service } from '../src'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import './shared'

describe('Service', () => {
  it('normal service', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }
    }

    const app = new App()
    app.plugin(Foo)
    expect(app.foo).to.be.undefined

    await app.start()
    expect(app.foo).to.be.instanceOf(Foo)

    app.dispose(Foo)
    expect(app.foo).to.be.undefined
  })

  it('immediate service', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
      }
    }

    const app = new App()
    app.plugin(Foo)
    expect(app.foo).to.be.instanceOf(Foo)
  })

  it('dependency update', async () => {
    const callback = jest.fn()
    const dispose = jest.fn(() => {})

    const app = new App()
    app.using(['foo'], (ctx) => {
      callback(ctx.foo.bar)
      ctx.on('dispose', dispose)
    })

    expect(callback.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)

    app.foo = { bar: 100 }
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0][0]).to.equal(100)
    expect(dispose.mock.calls).to.have.length(0)

    app.foo = { bar: 200 }
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls[1][0]).to.equal(200)
    expect(dispose.mock.calls).to.have.length(1)

    app.foo = null
    expect(callback.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(2)
  })

  it('lifecycle methods', async () => {
    const start = jest.fn<Service['start']>()
    const stop = jest.fn<Service['stop']>()
    const fork = jest.fn<Plugin.Function>()

    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }

      start = start
      stop = stop
      fork = fork
    }

    const app = new App()
    app.plugin(Foo)
    expect(start.mock.calls).to.have.length(0)
    expect(stop.mock.calls).to.have.length(0)
    expect(fork.mock.calls).to.have.length(1)

    await app.start()
    expect(start.mock.calls).to.have.length(1)
    expect(stop.mock.calls).to.have.length(0)
    expect(fork.mock.calls).to.have.length(1)

    app.plugin(Foo)
    expect(start.mock.calls).to.have.length(1)
    expect(stop.mock.calls).to.have.length(0)
    expect(fork.mock.calls).to.have.length(2)

    app.dispose(Foo)
    expect(start.mock.calls).to.have.length(1)
    expect(stop.mock.calls).to.have.length(1)
    expect(fork.mock.calls).to.have.length(2)
  })
})
