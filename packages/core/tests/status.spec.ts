import { Context, FiberState, Service } from '../src'
import { expect, describe, it } from 'vitest'
import { mock } from 'node:test'
import { sleep } from './utils'

describe('internal/status isolation', () => {
  it('observer throw does not fail a healthy plugin', async () => {
    const root = new Context()
    const error = mock.fn()
    ;(root.logger as any).error = error
    root.on('internal/status', () => {
      throw new Error('observer boom')
    })

    const fiber = root.plugin(() => {})
    await fiber
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(error.mock.calls.length).to.be.greaterThan(0)
  })

  it('observer throw does not overwrite plugin error', async () => {
    const root = new Context()
    const error = mock.fn()
    ;(root.logger as any).error = error
    root.on('internal/status', () => {
      throw new Error('observer boom')
    })

    const fiber = root.plugin(() => {
      throw new Error('plugin error')
    })
    await expect(fiber).rejects.toThrow('plugin error')
    expect(fiber.state).to.equal(FiberState.FAILED)
  })

  it('one throwing observer does not skip later observers', async () => {
    const root = new Context()
    ;(root.logger as any).error = mock.fn()
    const second = mock.fn()
    root.on('internal/status', () => {
      throw new Error('observer boom')
    })
    root.on('internal/status', second)

    await root.plugin(() => {})
    expect(second.mock.calls.length).to.be.greaterThan(0)
  })

  it('observer thenable rejection is contained', async () => {
    const root = new Context()
    const error = mock.fn()
    ;(root.logger as any).error = error
    root.on('internal/status', () => Promise.reject(new Error('observer boom')))

    const fiber = root.plugin(() => {})
    await fiber
    await sleep()
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(error.mock.calls.length).to.be.greaterThan(0)
  })

  it('observer throw does not skip service notify', async () => {
    const root = new Context()
    ;(root.logger as any).error = mock.fn()
    root.on('internal/status', () => {
      throw new Error('observer boom')
    })

    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }
    }

    let applied = false
    const provider = root.plugin(Foo)
    const consumer = root.inject(['foo'], () => {
      applied = true
    })
    await provider
    await consumer
    expect(applied).to.equal(true)
    expect(consumer.state).to.equal(FiberState.ACTIVE)
  })
})
