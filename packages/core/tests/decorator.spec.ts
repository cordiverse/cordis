import { Context, Inject, Service } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'

describe('Decorator', () => {
  it('@Inject on class method', () => {
    const callback = mock.fn()
    const dispose = mock.fn()

    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo', true)
      }
    }

    class Bar extends Service {
      constructor(ctx: Context) {
        super(ctx, 'bar', true)
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
    const fork = root.plugin(Foo)
    expect(callback.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
    fork.dispose()
    expect(callback.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(1)
  })
})
