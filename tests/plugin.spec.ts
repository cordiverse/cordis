import { App } from '../src'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import { inspect } from 'util'
import './shared'

describe('Plugin', () => {
  it('apply functional plugin', () => {
    const app = new App()
    const callback = jest.fn()
    const options = { foo: 'bar' }
    app.plugin(callback, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0][1]).to.deep.equal(options)
  })

  it('apply object plugin', () => {
    const app = new App()
    const callback = jest.fn()
    const options = { bar: 'foo' }
    const plugin = { apply: callback }
    app.plugin(plugin, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0][1]).to.deep.equal(options)
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
    expect(callback.mock.calls[0][1]).to.deep.equal({})
  })

  it('apply invalid plugin', () => {
    const app = new App()
    expect(() => app.plugin(undefined as any)).to.throw()
    expect(() => app.plugin({} as any)).to.throw()
    expect(() => app.plugin({ apply: {} } as any)).to.throw()
  })

  it('apply duplicate plugin', () => {
    const app = new App()
    const callback = jest.fn()
    app.plugin({ apply: callback })
    expect(callback.mock.calls).to.have.length(1)
    app.plugin({ apply: callback })
    expect(callback.mock.calls).to.have.length(1)
  })

  it('context inspect', () => {
    const app = new App()

    expect(inspect(app)).to.equal('Context <root>')

    app.plugin((ctx) => {
      expect(inspect(ctx)).to.equal('Context <anonymous>')
    })

    app.plugin(function foo(ctx) {
      expect(inspect(ctx)).to.equal('Context <foo>')
    })

    app.plugin({
      name: 'bar',
      apply: (ctx) => {
        expect(inspect(ctx)).to.equal('Context <bar>')
      },
    })

    app.plugin(class Qux {
      constructor(ctx) {
        expect(inspect(ctx)).to.equal('Context <Qux>')
      }
    })
  })
})
