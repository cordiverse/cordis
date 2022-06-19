import { App } from '../src'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import './shared'

describe('Isolation', () => {
  it('isolated context', async () => {
    const app = new App()
    const ctx = app.isolate(['foo'])

    const outer = jest.fn()
    const inner = jest.fn()
    app.on('internal/service', outer)
    ctx.on('internal/service', inner)

    app.foo = { bar: 100 }
    expect(app.foo).to.deep.equal({ bar: 100 })
    expect(ctx.foo).to.be.not.ok
    expect(outer.mock.calls).to.have.length(1)
    expect(inner.mock.calls).to.have.length(0)

    ctx.foo = { bar: 200 }
    expect(app.foo).to.deep.equal({ bar: 100 })
    expect(ctx.foo).to.deep.equal({ bar: 200 })
    expect(outer.mock.calls).to.have.length(1)
    expect(inner.mock.calls).to.have.length(1)

    app.foo = null
    expect(app.foo).to.be.not.ok
    expect(ctx.foo).to.deep.equal({ bar: 200 })
    expect(outer.mock.calls).to.have.length(2)
    expect(inner.mock.calls).to.have.length(1)

    ctx.foo = null
    expect(app.foo).to.be.not.ok
    expect(ctx.foo).to.be.not.ok
    expect(outer.mock.calls).to.have.length(2)
    expect(inner.mock.calls).to.have.length(2)
  })

  it('isolated fork', () => {
    const app = new App()
    const callback = jest.fn()
    const plugin = {
      reusable: true,
      using: ['foo'],
      apply: callback,
    }

    const ctx1 = app.isolate(['foo'])
    ctx1.plugin(plugin)
    const ctx2 = app.isolate(['foo'])
    ctx2.plugin(plugin)
    expect(callback.mock.calls).to.have.length(0)

    app.foo = { bar: 100 }
    expect(callback.mock.calls).to.have.length(0)
    ctx1.foo = { bar: 200 }
    expect(callback.mock.calls).to.have.length(1)
    ctx2.foo = { bar: 300 }
    expect(callback.mock.calls).to.have.length(2)
  })
})
