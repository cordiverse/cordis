import { Context } from '../src'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import { checkError, event } from './utils'

describe('Status', () => {
  it('invalid config (main)', async () => {
    const root = new Context()
    const callback = jest.fn()
    const apply = jest.fn((ctx: Context) => {
      ctx.on(event, callback)
    })
    const Config = jest.fn((config: { foo?: boolean } = {}) => {
      if (config.foo) return {}
      throw new Error('invalid config')
    })

    const fork = root.plugin({ Config, apply })
    expect(fork.status).to.equal('failed')
    expect(fork.runtime.status).to.equal('failed')
    expect(apply.mock.calls).to.have.length(0)

    fork.update({ foo: true })
    await checkError(root)
    expect(fork.status).to.equal('active')
    expect(fork.runtime.status).to.equal('active')
    expect(apply.mock.calls).to.have.length(1)

    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('invalid plugin (fork)', async () => {
    const root = new Context()
    const callback = jest.fn()
    const apply = jest.fn((ctx: Context) => {
      ctx.on(event, callback)
    })
    const Config = jest.fn((config: { foo?: boolean } = {}) => {
      if (config.foo) return config
      throw new Error('invalid config')
    })

    const fork1 = root.plugin({ reusable: true, Config, apply })
    const fork2 = root.plugin({ reusable: true, Config, apply }, { foo: true })
    await root.lifecycle.flush()

    expect(fork1.status).to.equal('failed')
    expect(fork2.status).to.equal('active')
    expect(apply.mock.calls).to.have.length(1)

    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('plugin error (main)', async () => {
    const root = new Context()
    const callback = jest.fn()
    const apply = jest.fn((ctx: Context) => {
      ctx.on(event, callback)
      throw new Error('plugin error')
    })

    const fork = root.plugin(apply)
    await root.lifecycle.flush()
    expect(fork.runtime.status).to.equal('failed')
    expect(fork.status).to.equal('active')
    expect(apply.mock.calls).to.have.length(1)

    root.emit(event)
    expect(callback.mock.calls).to.have.length(0)
  })

  it('plugin error (fork)', async () => {
    const root = new Context()
    const callback = jest.fn()
    const apply = jest.fn((ctx: Context, config: { foo?: boolean }) => {
      ctx.on(event, callback)
      if (!config.foo) throw new Error('plugin error')
    })

    const fork1 = root.plugin({ reusable: true, apply })
    const fork2 = root.plugin({ reusable: true, apply }, { foo: true })
    await root.lifecycle.flush()
    expect(fork1.status).to.equal('failed')
    expect(fork2.status).to.equal('active')
    expect(apply.mock.calls).to.have.length(2)

    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })
})
