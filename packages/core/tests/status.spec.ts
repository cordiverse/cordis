import { Context, ScopeStatus } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'
import { checkError, event } from './utils'

describe('Status', () => {
  it('invalid config (main)', async () => {
    const root = new Context()
    const callback = mock.fn()
    const error = mock.fn()
    root.on('internal/error', error)
    const apply = mock.fn((ctx: Context) => {
      ctx.on(event, callback)
    })
    const Config = mock.fn((config: { foo?: boolean } = {}) => {
      if (config.foo) return {}
      throw new Error('invalid config')
    })

    const fork = root.plugin({ Config, apply })
    expect(fork.status).to.equal(ScopeStatus.FAILED)
    expect(fork.runtime.status).to.equal(ScopeStatus.FAILED)
    expect(apply.mock.calls).to.have.length(0)
    expect(error.mock.calls).to.have.length(1)

    fork.update({ foo: true })
    await checkError(root)
    expect(fork.status).to.equal(ScopeStatus.ACTIVE)
    expect(fork.runtime.status).to.equal(ScopeStatus.ACTIVE)
    expect(apply.mock.calls).to.have.length(1)
    expect(error.mock.calls).to.have.length(1)

    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('invalid plugin (fork)', async () => {
    const root = new Context()
    const callback = mock.fn()
    const error = mock.fn()
    root.on('internal/error', error)
    const apply = mock.fn((ctx: Context) => {
      ctx.on(event, callback)
    })
    const Config = mock.fn((config: { foo?: boolean } = {}) => {
      if (config.foo) return config
      throw new Error('invalid config')
    })

    const fork1 = root.plugin({ Config, apply })
    const fork2 = root.plugin({ Config, apply }, { foo: true })

    expect(fork1.status).to.equal(ScopeStatus.FAILED)
    expect(fork2.status).to.equal(ScopeStatus.ACTIVE)
    expect(apply.mock.calls).to.have.length(1)
    expect(error.mock.calls).to.have.length(1)

    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('plugin error (main)', async () => {
    const root = new Context()
    const callback = mock.fn()
    const error = mock.fn()
    root.on('internal/error', error)
    const apply = mock.fn((ctx: Context) => {
      ctx.on(event, callback)
      throw new Error('plugin error')
    })

    const fork = root.plugin(apply)
    expect(fork.runtime?.status).to.equal(ScopeStatus.FAILED)
    expect(fork.status).to.equal(ScopeStatus.ACTIVE)
    expect(apply.mock.calls).to.have.length(1)
    expect(error.mock.calls).to.have.length(1)

    root.emit(event)
    expect(callback.mock.calls).to.have.length(0)
  })

  it('plugin error (fork)', async () => {
    const root = new Context()
    const callback = mock.fn()
    const error = mock.fn()
    root.on('internal/error', error)
    const apply = mock.fn((ctx: Context, config: { foo?: boolean } | undefined) => {
      ctx.on(event, callback)
      if (!config?.foo) throw new Error('plugin error')
    })

    const fork1 = root.plugin(apply)
    const fork2 = root.plugin(apply, { foo: true })
    expect(fork1.status).to.equal(ScopeStatus.FAILED)
    expect(fork2.status).to.equal(ScopeStatus.ACTIVE)
    expect(apply.mock.calls).to.have.length(2)
    expect(error.mock.calls).to.have.length(1)

    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })
})
