import { Context } from '../src'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import { Dict, noop } from 'cosmokit'
import { event } from './shared'

describe('Disposables', () => {
  it('context.prototype.dispose', () => {
    const plugin = (ctx: Context) => {
      ctx.on(event, callback)
      ctx.plugin((ctx) => {
        ctx.on(event, callback)
        ctx.plugin((ctx) => {
          ctx.on(event, callback)
        })
      })
    }

    const root = new Context()
    const callback = jest.fn()
    root.on(event, callback)
    root.plugin(plugin)

    // 3 handlers now
    expect(callback.mock.calls).to.have.length(0)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(4)

    // only 1 handler left
    callback.mockClear()
    root.registry.delete(plugin)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('memory leak test', async () => {
    function plugin(ctx: Context) {
      ctx.on('ready', noop)
      ctx.on(event, noop)
      ctx.on('dispose', noop)
    }

    function getHookSnapshot() {
      const result: Dict<number> = {}
      for (const [name, callbacks] of Object.entries(root.lifecycle._hooks)) {
        if (callbacks.length) result[name] = callbacks.length
      }
      return result
    }

    const root = new Context()
    const before = getHookSnapshot()
    root.plugin(plugin)
    const after = getHookSnapshot()
    root.registry.delete(plugin)
    expect(before).to.deep.equal(getHookSnapshot())
    root.plugin(plugin)
    expect(after).to.deep.equal(getHookSnapshot())
  })

  it('dispose event', () => {
    const root = new Context()
    const callback = jest.fn(noop)
    const plugin = (ctx: Context) => {
      ctx.on('dispose', callback)
    }

    root.plugin(plugin)
    expect(callback.mock.calls).to.have.length(0)
    expect(root.registry.delete(plugin)).to.be.ok
    expect(callback.mock.calls).to.have.length(1)
    // callback should only be called once
    expect(root.registry.delete(plugin)).to.be.not.ok
    expect(callback.mock.calls).to.have.length(1)
  })
})
