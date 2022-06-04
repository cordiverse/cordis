import { App, Plugin } from '../src'
import { expect } from 'chai'
import { event } from './shared'
import * as jest from 'jest-mock'

describe('Config', () => {
  it('basic support', () => {
    const app = new App()
    const dispose = jest.fn(() => {})
    const callback = jest.fn<Plugin.Function>((ctx) => {
      ctx.on('dispose', dispose)
      ctx.on(event, () => {
        ctx.state.update({ value: 2 })
      })
    })

    app.plugin(callback, { value: 1 })
    expect(dispose.mock.calls).to.have.length(0)
    expect(callback.mock.calls).to.have.length(1)
    app.emit(event)
    expect(dispose.mock.calls).to.have.length(1)
    expect(callback.mock.calls).to.have.length(2)

    expect(callback.mock.calls[0][0]).to.equal(callback.mock.calls[1][0])
    expect(callback.mock.calls[0][1]).to.deep.equal({ value: 1 })
    expect(callback.mock.calls[1][1]).to.deep.equal({ value: 2 })
  })

  it('update fork', () => {
    const app = new App()
    const inner = jest.fn<Plugin.Function>()
    const outer = jest.fn<Plugin.Function>((ctx) => {
      ctx.on('fork', inner)
    })

    const fork1 = app.plugin(outer, { value: 1 })
    const fork2 = app.plugin(outer, { value: 0 })
    expect(inner.mock.calls).to.have.length(2)
    expect(outer.mock.calls).to.have.length(1)

    fork2.update({ value: 2 })
    expect(inner.mock.calls).to.have.length(3)
    expect(outer.mock.calls).to.have.length(1)
    expect(fork1.config).to.deep.equal({ value: 1 })
    expect(fork2.config).to.deep.equal({ value: 2 })
  })

  it('deferred update', () => {
    const app = new App()
    const callback = jest.fn()
    const plugin = {
      using: ['foo'],
      reusable: true,
      apply: callback,
    }

    const fork = app.plugin(plugin, { value: 1 })
    expect(callback.mock.calls).to.have.length(0)
    fork.update({ value: 2 })
    expect(callback.mock.calls).to.have.length(0)
    app.foo = {}
    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0][1]).to.deep.equal({ value: 2 })
  })
})
