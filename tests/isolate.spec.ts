import { Context } from '../src'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import './utils'

describe('Isolation', () => {
  it('isolated context', async () => {
    const root = new Context()
    const ctx = root.isolate(['foo'])

    const outer = jest.fn()
    const inner = jest.fn()
    root.on('internal/service', outer)
    ctx.on('internal/service', inner)

    root.foo = { bar: 100 }
    expect(root.foo).to.have.property('bar', 100)
    expect(ctx.foo).to.be.not.ok
    expect(outer.mock.calls).to.have.length(1)
    expect(inner.mock.calls).to.have.length(0)

    ctx.foo = { bar: 200 }
    expect(root.foo).to.have.property('bar', 100)
    expect(ctx.foo).to.have.property('bar', 200)
    expect(outer.mock.calls).to.have.length(1)
    expect(inner.mock.calls).to.have.length(1)

    root.foo = null
    expect(root.foo).to.be.not.ok
    expect(ctx.foo).to.have.property('bar', 200)
    expect(outer.mock.calls).to.have.length(2)
    expect(inner.mock.calls).to.have.length(1)

    ctx.foo = null
    expect(root.foo).to.be.not.ok
    expect(ctx.foo).to.be.not.ok
    expect(outer.mock.calls).to.have.length(2)
    expect(inner.mock.calls).to.have.length(2)
  })

  it('isolated fork', () => {
    const root = new Context()
    const callback = jest.fn()
    const plugin = {
      reusable: true,
      using: ['foo'],
      apply: callback,
    }

    const ctx1 = root.isolate(['foo'])
    ctx1.plugin(plugin)
    const ctx2 = root.isolate(['foo'])
    ctx2.plugin(plugin)
    expect(callback.mock.calls).to.have.length(0)

    root.foo = { bar: 100 }
    expect(callback.mock.calls).to.have.length(0)
    ctx1.foo = { bar: 200 }
    expect(callback.mock.calls).to.have.length(1)
    ctx2.foo = { bar: 300 }
    expect(callback.mock.calls).to.have.length(2)
  })
})
