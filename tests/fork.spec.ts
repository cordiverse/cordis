import { App, Context, Filter } from '../src'
import { expect, use } from 'chai'
import * as jest from 'jest-mock'
import shape from 'chai-shape'

use(shape)

const event = Symbol('custom-event')
const filter: Filter = session => session.flag

declare module '../src/lifecycle' {
  interface Events {
    [event](): void
  }

  namespace Lifecycle {
    interface Session {
      flag: boolean
    }
  }
}

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
})
