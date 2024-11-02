import { Context } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'
import { noop, remove } from 'cosmokit'
import { event, getHookSnapshot } from './utils'

describe('Disposables', () => {
  it('scope.dispose', () => {
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
    const callback = mock.fn()
    root.on(event, callback)
    const scope = root.plugin(plugin)

    // 4 handlers by now
    expect(callback.mock.calls).to.have.length(0)
    expect(root.registry.size).to.equal(3)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(4)

    // only 1 handler left
    callback.mock.resetCalls()
    scope.dispose()
    expect(root.registry.size).to.equal(0)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)

    // subsequent calls should be noop
    callback.mock.resetCalls()
    scope.dispose()
    expect(root.registry.size).to.equal(0)
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
    const dispose = mock.fn(noop)
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

  it('dispose event error', async () => {
    const root = new Context()
    const error = mock.fn()
    const dispose = mock.fn(() => {
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

  describe('ctx.effect()', () => {
    it('plugin dispose', () => {
      const root = new Context()
      const dispose = mock.fn(noop)
  
      const scope = root.plugin((ctx: Context) => {
        ctx.effect(() => dispose)
      })
  
      scope.dispose()
      expect(dispose.mock.calls).to.have.length(1)
    })
  })
})
