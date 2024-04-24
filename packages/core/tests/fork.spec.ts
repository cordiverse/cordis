import { Context } from '../src'
import { noop } from 'cosmokit'
import { expect } from 'chai'
import { mock } from 'node:test'
import { event, Filter, Session, filter } from './utils'

describe('Fork', () => {
  it('basic support', () => {
    const callback = mock.fn()
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
    root.plugin(filter)
    root.extend(new Filter(true)).plugin(pluginA)
    root.emit(new Session(false), event)
    expect(callback.mock.calls).to.have.length(0)
    root.emit(new Session(true), event)
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments).to.deep.equal([1])

    callback.mock.resetCalls()
    root.extend(new Filter(false)).plugin(pluginB)
    root.emit(new Session(false), event)
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments).to.deep.equal([3])
    root.emit(new Session(true), event)
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls[1].arguments).to.deep.equal([3])

    callback.mock.resetCalls()
    root.registry.delete(pluginA)
    root.emit(new Session(true), event)
    expect(callback.mock.calls).to.have.length(0)
    root.emit(new Session(false), event)
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments).to.deep.equal([2])

    callback.mock.resetCalls()
    root.registry.delete(pluginB)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(0)
  })

  it('shorthand syntax', () => {
    const callback = mock.fn()
    const reusable = {
      reusable: true,
      apply(ctx: Context, config: { foo: number }) {
        ctx.on(event, () => callback(config.foo))
      },
    }

    const root = new Context()
    root.plugin(filter)
    root.plugin(reusable, { foo: 0 })
    root.extend(new Filter(true)).plugin(reusable, { foo: 1 })
    root.extend(new Filter(false)).plugin(reusable, { foo: 2 })

    root.emit(new Session(true), event)
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls[0].arguments).to.deep.equal([0])
    expect(callback.mock.calls[1].arguments).to.deep.equal([1])

    callback.mock.resetCalls()
    root.emit(new Session(false), event)
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls[0].arguments).to.deep.equal([0])
    expect(callback.mock.calls[1].arguments).to.deep.equal([2])

    callback.mock.resetCalls()
    root.registry.delete(reusable)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(0)
  })

  it('deferred execution', () => {
    const root = new Context()
    root.provide('foo')
    const listener = mock.fn()
    const callback = mock.fn((ctx: Context) => {
      ctx.on(event, listener)
    })
    const plugin = {
      inject: ['foo'],
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

    callback.mock.resetCalls()
    root.plugin(plugin)
    expect(callback.mock.calls).to.have.length(1)
    listener.mock.resetCalls()
    root.emit(event)
    expect(listener.mock.calls).to.have.length(3)

    callback.mock.resetCalls()
    root.foo = null
    root.foo = { bar: 200 }
    expect(callback.mock.calls).to.have.length(3)
    listener.mock.resetCalls()
    root.emit(event)
    expect(listener.mock.calls).to.have.length(3)
  })

  it('state.uid', () => {
    const root = new Context()
    const callback1 = mock.fn()
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
  })
})
