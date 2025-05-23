import { Context, Service } from 'cordis'
import { Inject } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'

describe('Decorator', () => {
  it('@Inject on class method', async () => {
    const callback = mock.fn()
    const dispose = mock.fn()

    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }
    }

    class Bar extends Service {
      constructor(ctx: Context) {
        super(ctx, 'bar')
      }

      @Inject('foo')
      method() {
        callback()
        return dispose
      }
    }

    const root = new Context()
    await root.plugin(Bar)
    expect(callback.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
    const fiber = await root.plugin(Foo)
    expect(callback.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
    await fiber.dispose()
    expect(callback.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(1)
  })
})
