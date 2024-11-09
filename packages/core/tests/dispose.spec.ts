import { Context } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'
import { noop } from 'cosmokit'
import { event, getHookSnapshot, sleep } from './utils'

describe('Disposables', () => {
  it('dispose by plugin', async () => {
    const root = new Context()
    const dispose = mock.fn()
    const scope = root.plugin((ctx: Context) => {
      ctx.effect(() => dispose)
    })
    expect(dispose.mock.calls).to.have.length(0)
    await scope.dispose()
    expect(dispose.mock.calls).to.have.length(1)
    await scope.dispose()
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('dispose manually', async () => {
    const root = new Context()
    const dispose1 = mock.fn()
    const dispose2 = root.effect(() => dispose1)
    expect(dispose1.mock.calls).to.have.length(0)
    dispose2()
    expect(dispose1.mock.calls).to.have.length(1)
    dispose2()
    expect(dispose1.mock.calls).to.have.length(1)
  })

  it('yield dispose', async () => {
    const root = new Context()
    const seq: number[] = []
    const dispose1 = mock.fn(() => seq.push(1))
    const dispose2 = mock.fn(() => seq.push(2))
    const dispose3 = mock.fn(() => seq.push(3))
    const dispose = root.effect(function* () {
      yield dispose1
      yield dispose2
      yield dispose3
    })
    expect(seq).to.deep.equal([])
    dispose()
    expect(seq).to.deep.equal([3, 2, 1])
    dispose()
    expect(seq).to.deep.equal([3, 2, 1])
  })

  it('effect with error', async () => {
    const root = new Context()
    const seq: number[] = []
    const dispose1 = mock.fn(() => seq.push(1))
    const dispose2 = mock.fn(() => seq.push(2))
    expect(() => {
      root.effect(function* () {
        yield dispose1
        throw new Error('test')
        yield dispose2
      })
    }).to.throw('test')
    expect(seq).to.deep.equal([1])
  })

  it('nested scopes', async () => {
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
    await scope.dispose()
    expect(root.registry.size).to.equal(0)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)

    // subsequent calls should be noop
    callback.mock.resetCalls()
    await scope.dispose()
    expect(root.registry.size).to.equal(0)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('memory leak test', async () => {
    function plugin(ctx: Context) {
      ctx.on(event, noop)
      ctx.on('dispose', noop)
    }

    const root = new Context()
    const before = getHookSnapshot(root)
    root.plugin(plugin)
    const after = getHookSnapshot(root)
    root.registry.delete(plugin)
    await sleep()
    expect(before).to.deep.equal(getHookSnapshot(root))
    root.plugin(plugin)
    expect(after).to.deep.equal(getHookSnapshot(root))
  })

  it('dispose event (deprecated)', async () => {
    const root = new Context()
    const dispose = mock.fn(noop)
    const plugin = (ctx: Context) => {
      ctx.on('dispose', dispose)
    }

    root.plugin(plugin)
    expect(dispose.mock.calls).to.have.length(0)
    expect(root.registry.delete(plugin)).to.be.ok
    await sleep()
    expect(dispose.mock.calls).to.have.length(1)
    // callback should only be called once
    expect(root.registry.delete(plugin)).to.be.not.ok
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('dispose error', async () => {
    const root = new Context()
    const error = mock.fn()
    root.on('internal/error', error)
    const dispose = mock.fn(() => {
      throw new Error('test')
    })
    const plugin = (ctx: Context) => {
      ctx.on('dispose', dispose)
    }

    root.plugin(plugin)
    expect(dispose.mock.calls).to.have.length(0)
    expect(root.registry.delete(plugin)).to.be.ok
    // error is asynchronous
    await sleep()
    expect(dispose.mock.calls).to.have.length(1)
    expect(error.mock.calls).to.have.length(1)
  })
})
