import { Context } from '../src'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import { noop } from 'cosmokit'
import { event, getHookSnapshot } from './utils'

describe('Disposables', () => {
  it('fork.dispose', () => {
    const plugin = (ctx: Context) => {
      ctx.on(event, callback)
      ctx.plugin((ctx) => {
        ctx.on(event, callback)
        ctx.plugin((ctx) => {
          ctx.on(event, callback)
        })
      })
    }

    const root = new Context()
    const callback = jest.fn()
    root.on(event, callback)
    const fork = root.plugin(plugin)

    // 4 handlers by now
    expect(callback.mock.calls).to.have.length(0)
    expect(root.registry.size).to.equal(4)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(4)

    // only 1 handler left
    callback.mockClear()
    expect(fork.dispose()).to.be.true
    expect(root.registry.size).to.equal(1)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)

    // subsequent calls should be noop
    callback.mockClear()
    expect(fork.dispose()).to.be.false
    expect(root.registry.size).to.equal(1)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('memory leak test', async () => {
    function plugin(ctx: Context) {
      ctx.on('ready', noop)
      ctx.on(event, noop)
      ctx.on('dispose', noop)
    }

    const root = new Context()
    const before = getHookSnapshot(root)
    root.plugin(plugin)
    const after = getHookSnapshot(root)
    root.registry.delete(plugin)
    expect(before).to.deep.equal(getHookSnapshot(root))
    root.plugin(plugin)
    expect(after).to.deep.equal(getHookSnapshot(root))
  })

  it('dispose event', () => {
    const root = new Context()
    const dispose = jest.fn(noop)
    const plugin = (ctx: Context) => {
      ctx.on('dispose', dispose)
    }

    root.plugin(plugin)
    expect(dispose.mock.calls).to.have.length(0)
    expect(root.registry.delete(plugin)).to.be.ok
    expect(dispose.mock.calls).to.have.length(1)
    // callback should only be called once
    expect(root.registry.delete(plugin)).to.be.not.ok
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('dispose event', async () => {
    const root = new Context()
    const error = jest.fn()
    const dispose = jest.fn(() => {
      throw new Error('test')
    })
    root.on('internal/error', error)
    const plugin = (ctx: Context) => {
      ctx.on('dispose', dispose)
    }

    root.plugin(plugin)
    expect(dispose.mock.calls).to.have.length(0)
    expect(root.registry.delete(plugin)).to.be.ok
    // error is asynchronous
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dispose.mock.calls).to.have.length(1)
    expect(error.mock.calls).to.have.length(1)
  })

  it('root dispose', async () => {
    const root = new Context()
    const callback = jest.fn(noop)
    const { length } = root.state.disposables

    root.on('ready', callback)
    expect(callback.mock.calls).to.have.length(0)

    await root.start()
    expect(callback.mock.calls).to.have.length(1)

    root.on('ready', callback)
    expect(callback.mock.calls).to.have.length(2)

    await root.stop()

    await root.start()
    expect(callback.mock.calls).to.have.length(2)
    expect(root.state.disposables.length).to.equal(length)
  })
})
