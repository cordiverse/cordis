import { Context } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'
import { inspect } from 'util'
import { checkError } from './utils'

describe('Plugin', () => {
  it('apply functional plugin', () => {
    const root = new Context()
    const callback = mock.fn()
    const options = { foo: 'bar' }
    root.plugin(callback, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments[1]).to.deep.equal(options)
  })

  it('apply object plugin', () => {
    const root = new Context()
    const callback = mock.fn()
    const options = { bar: 'foo' }
    const plugin = { apply: callback }
    root.plugin(plugin, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments[1]).to.deep.equal(options)
  })

  it('apply invalid plugin', () => {
    const root = new Context()
    expect(() => root.plugin(undefined as any)).to.throw()
    expect(() => root.plugin({} as any)).to.throw()
    expect(() => root.plugin({ apply: {} } as any)).to.throw()
  })

  it('apply duplicate plugin', () => {
    const root = new Context()
    const callback = mock.fn()
    root.plugin({ apply: callback })
    expect(callback.mock.calls).to.have.length(1)
    root.plugin({ apply: callback })
    expect(callback.mock.calls).to.have.length(1)
  })

  it('apply plugin when dispose', () => {
    const root = new Context()
    const callback = mock.fn()
    const fork = root.plugin((ctx) => {
      ctx.on('dispose', () => {
        expect(() => ctx.plugin(callback)).to.throw('inactive context')
        expect(() => ctx.on('ready', () => {})).to.throw('inactive context')
      })
    })
    fork.dispose()
    expect(callback.mock.calls).to.have.length(0)
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
