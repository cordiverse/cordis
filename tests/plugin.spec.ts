import { Context } from '../src'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import { inspect } from 'util'
import { checkError } from './utils'

describe('Plugin', () => {
  it('apply functional plugin', () => {
    const root = new Context()
    const callback = jest.fn()
    const options = { foo: 'bar' }
    root.plugin(callback, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0][1]).to.deep.equal(options)
  })

  it('apply object plugin', () => {
    const root = new Context()
    const callback = jest.fn()
    const options = { bar: 'foo' }
    const plugin = { apply: callback }
    root.plugin(plugin, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0][1]).to.deep.equal(options)
  })

  it('apply invalid plugin', () => {
    const root = new Context()
    expect(() => root.plugin(undefined as any)).to.throw()
    expect(() => root.plugin({} as any)).to.throw()
    expect(() => root.plugin({ apply: {} } as any)).to.throw()
  })

  it('apply duplicate plugin', () => {
    const root = new Context()
    const callback = jest.fn()
    root.plugin({ apply: callback })
    expect(callback.mock.calls).to.have.length(1)
    root.plugin({ apply: callback })
    expect(callback.mock.calls).to.have.length(1)
  })

  it('apply plugin when dispose', () => {
    const root = new Context()
    const callback = jest.fn()
    const warn = jest.fn()
    root.on('internal/warning', warn)
    const fork = root.plugin((ctx) => {
      ctx.on('dispose', () => {
        ctx.plugin(callback)
      })
    })
    fork.dispose()
    expect(callback.mock.calls).to.have.length(0)
    expect(warn.mock.calls).to.have.length(1)
  })

  it('context inspect', async () => {
    const root = new Context()

    expect(inspect(root)).to.equal('Context <root>')

    root.plugin((ctx) => {
      expect(inspect(ctx)).to.equal('Context <root>')
    })

    root.plugin(function foo(ctx) {
      expect(inspect(ctx)).to.equal('Context <foo>')
    })

    root.plugin({
      name: 'bar',
      apply: (ctx) => {
        expect(inspect(ctx)).to.equal('Context <bar>')
      },
    })

    root.plugin(class Qux {
      constructor(ctx: Context) {
        expect(inspect(ctx)).to.equal('Context <Qux>')
      }
    })

    await checkError(root)
  })

  it('registry', () => {
    // make coverage happy
    const root = new Context()
    root.registry.keys()
    root.registry.values()
    root.registry.entries()
    root.registry.forEach(() => {})
  })
})
