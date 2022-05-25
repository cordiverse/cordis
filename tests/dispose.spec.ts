import { App, Context } from '../src'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import { Dict } from 'cosmokit'
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

    const app = new App()
    const callback = jest.fn()
    app.on(event, callback)
    app.plugin(plugin)

    // 3 handlers now
    expect(callback.mock.calls).to.have.length(0)
    app.emit(event)
    expect(callback.mock.calls).to.have.length(4)

    // only 1 handler left
    callback.mockClear()
    app.dispose(plugin)
    app.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('memory leak test', async () => {
    function plugin(ctx: Context) {
      ctx.on('ready', () => {})
      ctx.on(event, () => {})
      ctx.on('dispose', () => {})
    }

    function getHookSnapshot() {
      const result: Dict<number> = {}
      for (const [name, callbacks] of Object.entries(app.lifecycle._hooks)) {
        if (callbacks.length) result[name] = callbacks.length
      }
      return result
    }

    const app = new App()
    const before = getHookSnapshot()
    app.plugin(plugin)
    const after = getHookSnapshot()
    app.dispose(plugin)
    expect(before).to.deep.equal(getHookSnapshot())
    app.plugin(plugin)
    expect(after).to.deep.equal(getHookSnapshot())
  })

  it('dispose event', () => {
    const app = new App()
    const callback = jest.fn(() => {})
    const plugin = (ctx: Context) => {
      ctx.on('dispose', callback)
    }

    app.plugin(plugin)
    expect(callback.mock.calls).to.have.length(0)
    expect(app.dispose(plugin)).to.be.ok
    expect(callback.mock.calls).to.have.length(1)
    // callback should only be called once
    expect(app.dispose(plugin)).to.be.not.ok
    expect(callback.mock.calls).to.have.length(1)
  })
})
