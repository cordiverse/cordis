import { Context } from '../src'
import { expect } from 'chai'
import { describe, mock, test } from 'node:test'
import { noop, remove } from 'cosmokit'
import { event, getHookSnapshot } from './utils'

describe('Disposables', () => {
  test('fork.dispose', () => {
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
    const fork = root.plugin(plugin)

    // 4 handlers by now
    expect(callback.mock.calls).to.have.length(0)
    expect(root.registry.size).to.equal(4)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(4)

    // only 1 handler left
    callback.mock.resetCalls()
    expect(fork.dispose()).to.be.true
    expect(root.registry.size).to.equal(1)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)

    // subsequent calls should be noop
    callback.mock.resetCalls()
    expect(fork.dispose()).to.be.false
    expect(root.registry.size).to.equal(1)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  test('memory leak test', async () => {
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

  test('dispose event', () => {
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

  test('dispose event', async () => {
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

  test('root dispose', async () => {
    const root = new Context()
    const callback = mock.fn(noop)
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

  test('ctx.effect()', async () => {
    const root = new Context()
    const dispose = mock.fn(noop)
    const items: Item[] = []

    class Item {
      constructor() {
        items.push(this)
      }

      dispose() {
        dispose()
        remove(items, this)
      }
    }

    const item1 = root.effect(() => new Item())
    const item2 = root.effect(() => new Item())
    expect(item1).instanceof(Item)
    expect(item2).instanceof(Item)
    expect(dispose.mock.calls).to.have.length(0)
    expect(items).to.have.length(2)

    item1.dispose()
    expect(dispose.mock.calls).to.have.length(1)
    expect(items).to.have.length(1)

    item1.dispose()
    expect(dispose.mock.calls).to.have.length(1)
    expect(items).to.have.length(1)

    item2.dispose()
    expect(dispose.mock.calls).to.have.length(2)
    expect(items).to.have.length(0)
  })
})
