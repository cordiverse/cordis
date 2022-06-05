import { App, Context } from '../src'
import { expect } from 'chai'
import { event, filter } from './shared'
import * as jest from 'jest-mock'

describe('Fork', () => {
  it('basic support', () => {
    const callback = jest.fn()
    const reusable = (ctx: Context) => {
      let foo = 0
      ctx.on(event, () => callback(foo))
      ctx.on('fork', (ctx, config: { foo: number }) => {
        foo |= config.foo
        ctx.on('dispose', () => {
          foo &= ~config.foo
        })
      })
    }

    const pluginA = (ctx: Context) => {
      ctx.plugin(reusable, { foo: 1 })
    }
    const pluginB = (ctx: Context) => {
      ctx.plugin(reusable, { foo: 2 })
    }

    const app = new App()
    app.intersect(filter).plugin(pluginA)
    app.emit({ flag: false }, event)
    expect(callback.mock.calls).to.have.length(0)
    app.emit({ flag: true }, event)
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0]).to.have.shape([1])

    callback.mockClear()
    app.exclude(filter).plugin(pluginB)
    app.emit({ flag: false }, event)
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0]).to.have.shape([3])
    app.emit({ flag: true }, event)
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls[1]).to.have.shape([3])

    callback.mockClear()
    app.dispose(pluginA)
    app.emit({ flag: true }, event)
    expect(callback.mock.calls).to.have.length(0)
    app.emit({ flag: false }, event)
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0]).to.have.shape([2])

    callback.mockClear()
    app.dispose(pluginB)
    app.emit(event)
    expect(callback.mock.calls).to.have.length(0)
  })

  it('shorthand syntax', () => {
    const callback = jest.fn()
    const reusable = {
      reusable: true,
      apply(ctx: Context, config: { foo: number }) {
        ctx.on(event, () => callback(config.foo))
      },
    }

    const app = new App()
    app.plugin(reusable, { foo: 0 })
    app.intersect(filter).plugin(reusable, { foo: 1 })
    app.exclude(filter).plugin(reusable, { foo: 2 })

    app.emit({ flag: true }, event)
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls).to.have.shape([[0], [1]])

    callback.mockClear()
    app.emit({ flag: false }, event)
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls).to.have.shape([[0], [2]])

    callback.mockClear()
    app.dispose(reusable)
    app.emit(event)
    expect(callback.mock.calls).to.have.length(0)
  })

  it('deferred execution', () => {
    const app = new App()
    const listener = jest.fn()
    const callback = jest.fn((ctx: Context) => {
      ctx.on(event, listener)
    })
    const plugin = {
      using: ['foo'],
      apply(ctx: Context) {
        ctx.on('fork', callback)
      },
    }

    app.plugin(plugin)
    expect(callback.mock.calls).to.have.length(0)
    app.plugin(plugin)
    expect(callback.mock.calls).to.have.length(0)
    app.emit(event)
    expect(listener.mock.calls).to.have.length(0)

    app.foo = { bar: 100 }
    expect(callback.mock.calls).to.have.length(2)
    app.emit(event)
    expect(listener.mock.calls).to.have.length(2)

    callback.mockClear()
    app.plugin(plugin)
    expect(callback.mock.calls).to.have.length(1)
    listener.mockClear()
    app.emit(event)
    expect(listener.mock.calls).to.have.length(3)

    callback.mockClear()
    app.foo = { bar: 200 }
    expect(callback.mock.calls).to.have.length(3)
    listener.mockClear()
    app.emit(event)
    expect(listener.mock.calls).to.have.length(3)
  })
})
