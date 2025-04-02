import { Context, FiberState } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'
import { event, sleep } from './utils'

describe('Fiber', () => {
  it('plugin error', async () => {
    const root = new Context()
    const callback = mock.fn()
    const error = mock.fn()
    root.on('internal/error', error)
    const apply = mock.fn((ctx: Context, config: { foo?: boolean } | undefined) => {
      ctx.on(event, callback)
      if (!config?.foo) throw new Error('plugin error')
    })

    const fiber1 = root.plugin(apply)
    const fiber2 = root.plugin(apply, { foo: true })
    await sleep()
    expect(fiber1.state).to.equal(FiberState.FAILED)
    expect(fiber2.state).to.equal(FiberState.ACTIVE)
    // expect(apply.mock.calls).to.have.length(2)
    expect(error.mock.calls).to.have.length(1)

    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('dispose error', async () => {
    const root = new Context()
    const error = mock.fn()
    root.on('internal/error', error)
    const dispose = mock.fn(() => {
      throw new Error('test')
    })
    const plugin = (ctx: Context) => {
      return dispose
    }

    const fiber = root.plugin(plugin)
    await fiber
    expect(dispose.mock.calls).to.have.length(0)
    await expect(fiber.dispose()).to.be.fulfilled
    await sleep()
    expect(dispose.mock.calls).to.have.length(1)
    expect(error.mock.calls).to.have.length(1)
  })
})
