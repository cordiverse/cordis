import { Context } from '../src'
import { expect } from 'chai'
import { noop } from 'cosmokit'
import { event } from './utils'
import * as jest from 'jest-mock'

describe('Update', () => {
  interface Config {
    foo?: number
    bar?: number
  }

  it('update runtime', () => {
    const root = new Context()
    const dispose = jest.fn(noop)
    const plugin = jest.fn((ctx: Context, config: Config) => {
      ctx.on('dispose', dispose)
      ctx.on(event, () => {
        ctx.state.update({ foo: 2 })
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
    const listener = jest.fn((value?: number) => {})
    const updater = jest.fn(() => {})
    const plugin = jest.fn((ctx: Context<Config>) => {
      ctx.on(event, () => listener(ctx.config.foo))
      // accept only foo
      ctx.accept(['foo'], updater, { immediate: true })
    })

    const fork = root.plugin(plugin, { foo: 1 })
    expect(plugin.mock.calls).to.have.length(1)
    expect(updater.mock.calls).to.have.length(1)

    root.emit(event)
    expect(listener.mock.calls).to.have.length(1)
    expect(listener.mock.calls[0][0]).to.deep.equal(1)

    fork.update({ foo: 2 })
    expect(plugin.mock.calls).to.have.length(1)
    expect(updater.mock.calls).to.have.length(2)

    root.emit(event)
    expect(listener.mock.calls).to.have.length(2)
    expect(listener.mock.calls[1][0]).to.deep.equal(2)

    fork.update({ foo: 2, bar: 3 })
    expect(plugin.mock.calls).to.have.length(2)
    expect(updater.mock.calls).to.have.length(3)
  })

  it('update fork (multiple)', () => {
    const root = new Context()
    const inner = jest.fn((ctx: Context) => {
      ctx.decline(['foo'])
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

  it('nested update', () => {
    const root = new Context()
    const listener = jest.fn((value?: number) => {})
    const inner = jest.fn((ctx: Context<Config>, config: Config) => {
      // accept everything except bar
      ctx.decline(['bar'])
      ctx.on(event, () => listener(config.foo))
    })
    const plugin = {
      reusable: true,
      reactive: true,
      apply: inner,
    }
    const outer = jest.fn((ctx: Context, config: Config & { qux?: Config }) => {
      const fork1 = ctx.plugin(plugin, config)
      const fork2 = ctx.plugin(plugin, config.qux)
      ctx.accept((config) => {
        fork1.update(config)
      }, { passive: true })
      ctx.accept(['qux'], (config) => {
        fork2.update(config.qux)
      }, { passive: true })
    })

    const fork = root.plugin(outer, { foo: 1, bar: 1 })
    expect(outer.mock.calls).to.have.length(1)
    expect(inner.mock.calls).to.have.length(2)
    root.emit(event)
    expect(listener.mock.calls).to.have.length(2)
    expect(listener.mock.calls[0][0]).to.equal(1)
    expect(listener.mock.calls[1][0]).to.equal(undefined)
    listener.mockClear()

    fork.update({ foo: 1 })
    expect(outer.mock.calls).to.have.length(1)
    expect(inner.mock.calls).to.have.length(3)

    fork.update({})
    expect(outer.mock.calls).to.have.length(1)
    expect(inner.mock.calls).to.have.length(3)

    root.emit(event)
    expect(listener.mock.calls).to.have.length(2)
    expect(listener.mock.calls[0][0]).to.equal(undefined)
    expect(listener.mock.calls[1][0]).to.equal(undefined)
    listener.mockClear()

    fork.update({ foo: 1, qux: { foo: 1 } })
    expect(outer.mock.calls).to.have.length(1)
    expect(inner.mock.calls).to.have.length(3)

    root.emit(event)
    expect(listener.mock.calls).to.have.length(2)
    expect(listener.mock.calls[0][0]).to.equal(1)
    expect(listener.mock.calls[1][0]).to.equal(1)
    listener.mockClear()

    fork.update({ qux: { foo: 1, bar: 1 } })
    expect(outer.mock.calls).to.have.length(1)
    expect(inner.mock.calls).to.have.length(4)

    root.emit(event)
    expect(listener.mock.calls).to.have.length(2)
    expect(listener.mock.calls[0][0]).to.equal(undefined)
    expect(listener.mock.calls[1][0]).to.equal(1)
    listener.mockClear()
  })

  it('deferred update', () => {
    const root = new Context()
    const callback = jest.fn()
    const plugin = {
      inject: ['foo'],
      reusable: true,
      apply: callback,
    }

    const fork = root.plugin(plugin, { value: 1 })
    expect(callback.mock.calls).to.have.length(0)

    fork.update({ value: 2 }, true)
    expect(callback.mock.calls).to.have.length(0)

    root.foo = {}
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0][1]).to.deep.equal({ value: 2 })
    expect(fork.disposables).to.have.length(2)              // service listener
    expect(fork.runtime.disposables).to.have.length(1)      // fork

    fork.update({ value: 3 }, true)
    expect(callback.mock.calls).to.have.length(2)
    expect(callback.mock.calls[1][1]).to.deep.equal({ value: 3 })
    expect(fork.disposables).to.have.length(2)              // service listener
    expect(fork.runtime.disposables).to.have.length(1)      // fork
  })

  it('root update', async () => {
    const root = new Context()
    const callback = jest.fn(noop)
    const { length } = root.state.disposables

    root.decline(['foo'])
    root.on('dispose', callback)
    expect(callback.mock.calls).to.have.length(0)

    root.state.update({ maxListeners: 100 })
    expect(callback.mock.calls).to.have.length(0)

    root.state.update({ foo: 100 })
    expect(callback.mock.calls).to.have.length(1)
    expect(root.state.disposables.length).to.equal(length)
  })
})
