import { Context, Inject, Service } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'
import { sleep } from './utils'

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

      @Inject(['foo'])
      method() {
        callback()
        this.ctx.on('dispose', dispose)
      }
    }

    const root = new Context()
    root.plugin(Bar)
    expect(callback.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
    const scope = root.plugin(Foo)
    await sleep()
    expect(callback.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
    await scope.dispose()
    expect(callback.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(1)
  })
})
