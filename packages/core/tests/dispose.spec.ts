import { Context } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'
import { noop } from 'cosmokit'
import { event, getHookSnapshot, sleep } from './utils'

describe('Disposables', () => {
  it('dispose by plugin', async () => {
    const root = new Context()
    const dispose = mock.fn()
    const scope = root.plugin((ctx) => {
      ctx.effect(() => dispose, 'test')
    })
    await scope
    expect(scope.getEffects()).to.deep.equal([
      { label: 'test', children: [] },
    ])
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
    expect(root.scope.getEffects()).to.deep.equal([
      { label: 'anonymous', children: [] },
    ])
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
      yield root.on('internal/service', () => {})
      yield dispose2
      yield root.effect(function* () {
        yield root.on('internal/before-service', () => {})
        yield dispose3
      })
    })
    root.on('custom-event', () => {})
    expect(root.scope.getEffects()).to.deep.equal([
      {
        label: 'anonymous',
        children: [
          // only root level anonymous effects are included
          { label: 'ctx.on("internal/service")', children: [] },
          {
            label: 'anonymous',
            children: [
              { label: 'ctx.on("internal/before-service")', children: [] },
            ],
          },
        ],
      },
      { label: 'ctx.on("custom-event")', children: [] },
    ])
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
    const plugin = async (ctx: Context) => {
      ctx.on(event, callback)
      await ctx.plugin(async (ctx) => {
        ctx.on(event, callback)
        await ctx.plugin((ctx) => {
          ctx.on(event, callback)
        })
      })
    }

    const root = new Context()
    const callback = mock.fn()
    root.on(event, callback)
    const scope = root.plugin(plugin)

    // 4 handlers by now
    await scope
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
    await root.plugin(plugin)
    const after = getHookSnapshot(root)
    root.registry.delete(plugin)
    await sleep()
    expect(before).to.deep.equal(getHookSnapshot(root))
    await root.plugin(plugin)
    expect(after).to.deep.equal(getHookSnapshot(root))
  })

  it('dispose event (deprecated)', async () => {
    const root = new Context()
    const dispose = mock.fn(noop)
    const plugin = (ctx: Context) => {
      ctx.on('dispose', dispose)
    }

    await root.plugin(plugin)
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

    await root.plugin(plugin)
    expect(dispose.mock.calls).to.have.length(0)
    expect(root.registry.delete(plugin)).to.be.ok
    // error is asynchronous
    await sleep()
    expect(dispose.mock.calls).to.have.length(1)
    expect(error.mock.calls).to.have.length(1)
  })

  it('root dispose', async () => {
    const root = new Context()
    const dispose = mock.fn()
    root.plugin((ctx) => {
      return dispose
    })
    expect(root.scope.disposables.length).to.equal(1)
    expect(dispose.mock.calls).to.have.length(0)
    await root.scope.dispose()
    expect(dispose.mock.calls).to.have.length(1)
    await root.scope.dispose()
    expect(dispose.mock.calls).to.have.length(1)
  })
})
