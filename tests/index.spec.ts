import { App, Context } from '../src'
import { expect, use } from 'chai'
import * as jest from 'jest-mock'
import { inspect } from 'util'
import { Dict } from 'cosmokit'
import shape from 'chai-shape'

use(shape)

declare module '../src/lifecycle' {
  interface Events {
    'attach'(): void
  }
}

const app = new App()

describe('Plugin API', () => {
  it('apply functional plugin', () => {
    const app = new App()
    const callback = jest.fn()
    const options = { foo: 'bar' }
    app.plugin(callback, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0][1]).to.have.shape(options)
  })

  it('apply object plugin', () => {
    const app = new App()
    const callback = jest.fn()
    const options = { bar: 'foo' }
    const plugin = { apply: callback }
    app.plugin(plugin, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0][1]).to.have.shape(options)
  })

  it('apply functional plugin with false', () => {
    const app = new App()
    const callback = jest.fn()
    app.plugin(callback, false)

    expect(callback.mock.calls).to.have.length(0)
  })

  it('apply object plugin with true', () => {
    const app = new App()
    const callback = jest.fn()
    const plugin = { apply: callback }
    app.plugin(plugin, true)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0][1]).to.have.shape({})
  })

  it('apply invalid plugin', () => {
    const app = new App()
    expect(() => app.plugin(undefined)).to.throw()
    expect(() => app.plugin({} as any)).to.throw()
    expect(() => app.plugin({ apply: {} } as any)).to.throw()
  })

  it('apply duplicate plugin', () => {
    const app = new App()
    const callback = jest.fn()
    const plugin = { apply: callback }
    app.plugin(plugin)
    expect(callback.mock.calls).to.have.length(1)
    app.plugin(plugin)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('context inspect', () => {
    const app = new App()

    expect(inspect(app)).to.equal('Context <root>')

    app.plugin(function foo(ctx) {
      expect(inspect(ctx)).to.equal('Context <foo>')
    })

    app.plugin({
      name: 'bar',
      apply: (ctx) => {
        expect(inspect(ctx)).to.equal('Context <bar>')
      },
    })
  })
})

describe('Disposable API', () => {
  it('context.prototype.dispose', () => {
    const app = new App()
    const callback = jest.fn()
    let pluginCtx: Context
    app.on('attach', callback)
    app.plugin((ctx) => {
      pluginCtx = ctx
      ctx.on('attach', callback)
      ctx.plugin((ctx) => {
        ctx.on('attach', callback)
      })
    })

    // 3 handlers now
    expect(callback.mock.calls).to.have.length(0)
    app.emit('attach')
    expect(callback.mock.calls).to.have.length(3)

    // only 1 handler left
    pluginCtx.dispose()
    app.emit('attach')
    expect(callback.mock.calls).to.have.length(4)
  })

  it('memory leak test', async () => {
    function plugin(ctx: Context) {
      ctx.on('ready', () => {})
      ctx.on('attach', () => {})
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

  it('root level dispose', async () => {
    const app = new App()
    // create a context without a plugin
    const ctx = app.intersect(app)
    expect(() => ctx.dispose()).to.throw
  })

  it('dispose event', () => {
    const app = new App()
    const callback = jest.fn<void, []>()
    app.plugin(async (ctx) => {
      ctx.on('dispose', callback)
      expect(callback.mock.calls).to.have.length(0)
      ctx.dispose()
      expect(callback.mock.calls).to.have.length(1)
      // callback should only be called once
      ctx.dispose()
      expect(callback.mock.calls).to.have.length(1)
    })
  })
})
