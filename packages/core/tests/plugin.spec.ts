import { Context } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'
import { inspect } from 'util'

describe('Plugin', () => {
  it('apply functional plugin', async () => {
    const root = new Context()
    const callback = mock.fn()
    const options = { foo: 'bar' }
    await root.plugin(callback, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments[1]).to.deep.equal(options)
  })

  it('apply object plugin', async () => {
    const root = new Context()
    const callback = mock.fn()
    const options = { bar: 'foo' }
    const plugin = { apply: callback }
    await root.plugin(plugin, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments[1]).to.deep.equal(options)
  })

  it('apply invalid plugin', async () => {
    const root = new Context()
    expect(() => root.plugin(undefined as any)).to.throw()
    expect(() => root.plugin({} as any)).to.throw()
    expect(() => root.plugin({ apply: {} } as any)).to.throw()
  })

  it('apply plugin when dispose', async () => {
    const root = new Context()
    const callback = mock.fn()
    const scope = root.plugin((ctx) => {
      return () => {
        expect(() => ctx.plugin(callback)).to.throw('inactive context')
        expect(() => ctx.on('custom-event', () => {})).to.throw('inactive context')
      }
    })
    await scope
    await scope.dispose()
    expect(callback.mock.calls).to.have.length(0)
  })

  it('context inspect', async () => {
    const root = new Context()

    expect(inspect(root)).to.equal('Context <root>')

    await root.plugin((ctx) => {
      expect(inspect(ctx)).to.equal('Context <root>')
    })

    await root.plugin(function foo(ctx) {
      expect(inspect(ctx)).to.equal('Context <foo>')
    })

    await root.plugin({
      name: 'bar',
      apply: (ctx) => {
        expect(inspect(ctx)).to.equal('Context <bar>')
      },
    })

    await root.plugin(class Qux {
      constructor(ctx: Context) {
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
