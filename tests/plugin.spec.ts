import { Context } from '../src'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import { inspect } from 'util'
import './utils'

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

  it('apply functional plugin with false', () => {
    const root = new Context()
    const callback = jest.fn()
    root.plugin(callback, false)

    expect(callback.mock.calls).to.have.length(0)
  })

  it('apply object plugin with true', () => {
    const root = new Context()
    const callback = jest.fn()
    const plugin = { apply: callback }
    root.plugin(plugin, true)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0][1]).to.deep.equal({})
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

  it('context inspect', () => {
    const root = new Context()

    expect(inspect(root)).to.equal('Context <root>')

    root.plugin((ctx) => {
      expect(inspect(ctx)).to.equal('Context <anonymous>')
    })

    root.plugin(function foo(ctx) {
      expect(inspect(ctx)).to.equal('Context <foo>')
    })

    root.plugin({
      name: 'bar',
      apply: (ctx: Context, config: {foo: 1}) => {
        expect(inspect(ctx)).to.equal('Context <bar>')
      },
    })

    root.plugin(class Qux {
      constructor(ctx) {
        expect(inspect(ctx)).to.equal('Context <Qux>')
      }
    })
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
