import { Context } from '../src'
import { noop } from 'cosmokit'
import { expect } from 'chai'
import { event, Filter, Session, union } from './utils'
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

    const root = new Context()
    root.plugin(union)
    root.extend(new Filter(true)).plugin(pluginA)
    root.emit(new Session(false), event)
    expect(callback.mock.calls).to.have.length(0)
    root.emit(new Session(true), event)
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0]).to.deep.equal([1])

    callback.mockClear()
    root.extend(new Filter(false)).plugin(pluginB)
    root.emit(new Session(false), event)
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0]).to.deep.equal([3])
    root.emit(new Session(true), event)
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls[1]).to.deep.equal([3])

    callback.mockClear()
    root.registry.delete(pluginA)
    root.emit(new Session(true), event)
    expect(callback.mock.calls).to.have.length(0)
    root.emit(new Session(false), event)
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0]).to.deep.equal([2])

    callback.mockClear()
    root.registry.delete(pluginB)
    root.emit(event)
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

    const root = new Context()
    root.plugin(reusable, { foo: 0 })
    root.extend(new Filter(true)).plugin(reusable, { foo: 1 })
    root.extend(new Filter(false)).plugin(reusable, { foo: 2 })

    root.emit(new Session(true), event)
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls).to.deep.equal([[0], [1]])

    callback.mockClear()
    root.emit(new Session(false), event)
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls).to.deep.equal([[0], [2]])

    callback.mockClear()
    root.registry.delete(reusable)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(0)
  })

  it('deferred execution', () => {
    const root = new Context()
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

    root.plugin(plugin)
    expect(callback.mock.calls).to.have.length(0)
    root.plugin(plugin)
    expect(callback.mock.calls).to.have.length(0)
    root.emit(event)
    expect(listener.mock.calls).to.have.length(0)

    root.foo = { bar: 100 }
    expect(callback.mock.calls).to.have.length(2)
    root.emit(event)
    expect(listener.mock.calls).to.have.length(2)

    callback.mockClear()
    root.plugin(plugin)
    expect(callback.mock.calls).to.have.length(1)
    listener.mockClear()
    root.emit(event)
    expect(listener.mock.calls).to.have.length(3)

    callback.mockClear()
    root.foo = null
    root.foo = { bar: 200 }
    expect(callback.mock.calls).to.have.length(3)
    listener.mockClear()
    root.emit(event)
    expect(listener.mock.calls).to.have.length(3)
  })

  it('state.uid', () => {
    const root = new Context()
    const callback1 = jest.fn()
    expect(root.state.uid).to.equal(0)

    const fork1 = root.plugin(callback1)
    expect(fork1.runtime.uid).to.equal(1)
    expect(fork1.uid).to.equal(2)

    const fork2 = root.plugin(noop)
    expect(fork2.runtime.uid).to.equal(3)
    expect(fork2.uid).to.equal(4)

    const fork3 = root.plugin(callback1)
    expect(fork3.runtime.uid).to.equal(1)
    expect(fork3.uid).to.equal(5)

    // make coverage happy
    root.runtime = root.runtime
  })
})
