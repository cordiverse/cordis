import { Context } from '../src'
import { expect } from 'chai'
import { noop } from 'cosmokit'
import { event } from './shared'
import * as jest from 'jest-mock'

describe('Update', () => {
  interface Config {
    foo: number
    bar?: number
  }

  it('update runtime', () => {
    const root = new Context()
    const dispose = jest.fn(noop)
    const plugin = jest.fn((ctx: Context, config: Config) => {
      ctx.on('dispose', dispose)
      ctx.on(event, () => {
        ctx.update({ foo: 2 })
      })
      // make coverage happy
      ctx.on('fork', noop)
    })

    root.plugin(plugin, { foo: 1 })
    expect(dispose.mock.calls).to.have.length(0)
    expect(plugin.mock.calls).to.have.length(1)

    // update config, should trigger reload
    root.emit(event)
    expect(dispose.mock.calls).to.have.length(1)
    expect(plugin.mock.calls).to.have.length(2)

    // update config, should not trigger reload
    root.emit(event)
    expect(dispose.mock.calls).to.have.length(1)
    expect(plugin.mock.calls).to.have.length(2)

    expect(plugin.mock.calls[0][0]).to.equal(plugin.mock.calls[1][0])
    expect(plugin.mock.calls[0][1]).to.deep.equal({ foo: 1 })
    expect(plugin.mock.calls[1][1]).to.deep.equal({ foo: 2 })
  })

  it('update fork (single)', () => {
    const root = new Context()
    const callback = jest.fn((value: number) => {})
    const plugin = jest.fn((ctx, config: Config) => {
      ctx.on(event, () => callback(config.foo))
      ctx.accept(['foo'], () => true)
      ctx.accept(['bar'])
    })

    const fork = root.plugin(plugin, { foo: 1 })
    expect(plugin.mock.calls).to.have.length(1)

    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0][0]).to.deep.equal(1)

    fork.update({ foo: 2 })
    expect(plugin.mock.calls).to.have.length(2)

    root.emit(event)
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls[1][0]).to.deep.equal(2)

    fork.update({ foo: 2, bar: 3 })
    expect(plugin.mock.calls).to.have.length(2)

    fork.update({ foo: 2, bar: 3, qux: 4 })
    expect(plugin.mock.calls).to.have.length(3)
  })

  it('update fork (multiple)', () => {
    const root = new Context()
    const inner = jest.fn((ctx: Context) => {
      ctx.accept(['foo'], () => true)
      ctx.accept(['bar'])
    })
    const outer = jest.fn((ctx: Context, config: Config) => {
      ctx.on('fork', inner)
    })

    const fork1 = root.plugin(outer, { foo: 1, bar: 1 })
    const fork2 = root.plugin(outer, { foo: 2, bar: 2 })
    expect(inner.mock.calls).to.have.length(2)
    expect(outer.mock.calls).to.have.length(1)

    fork1.update({ foo: 2, bar: 1 })
    expect(inner.mock.calls).to.have.length(3)
    expect(outer.mock.calls).to.have.length(1)
    expect(fork1.config).to.deep.equal({ foo: 2, bar: 1 })
    expect(fork2.config).to.deep.equal({ foo: 2, bar: 2 })

    fork2.update({ foo: 2, bar: 1 })
    expect(inner.mock.calls).to.have.length(3)
    expect(outer.mock.calls).to.have.length(1)
    expect(fork1.config).to.deep.equal({ foo: 2, bar: 1 })
    expect(fork2.config).to.deep.equal({ foo: 2, bar: 1 })
  })

  it('deferred update', () => {
    const root = new Context()
    const callback = jest.fn()
    const plugin = {
      using: ['foo'],
      reusable: true,
      apply: callback,
    }

    const fork = root.plugin(plugin, { value: 1 })
    expect(callback.mock.calls).to.have.length(0)

    fork.update({ value: 2 })
    expect(callback.mock.calls).to.have.length(0)

    root.foo = {}
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0][1]).to.deep.equal({ value: 2 })
    expect(fork.disposables).to.have.length(2)              // service listener
    expect(fork.runtime.disposables).to.have.length(1)      // fork

    fork.update({ value: 3 })
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls[1][1]).to.deep.equal({ value: 3 })
    expect(fork.disposables).to.have.length(2)              // service listener
    expect(fork.runtime.disposables).to.have.length(1)      // fork
  })

  it('root update', async () => {
    const root = new Context()
    const callback = jest.fn(noop)
    const { length } = root.state.disposables

    root.on('dispose', callback)
    expect(callback.mock.calls).to.have.length(0)

    root.update({ maxListeners: 100 })
    expect(callback.mock.calls).to.have.length(0)

    root.update({ foo: 100 })
    expect(callback.mock.calls).to.have.length(1)
    expect(root.state.disposables.length).to.equal(length)
  })
})
