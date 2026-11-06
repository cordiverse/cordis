import { Context, Service } from 'cordis'
import { Inject } from '../src/index.ts'
import { expect, describe, it } from 'vitest'
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

  it('@Inject on class method keeps the service as this', async () => {
    let rendered: string | undefined

    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }
    }

    class Bar extends Service {
      constructor(ctx: Context) {
        super(ctx, 'bar')
      }

      toString() {
        return 'Bar<bar>'
      }

      @Inject('foo')
      method() {
        // only `ctx` is replaced; everything else is still the service
        expect(this.ctx.foo).to.be.ok
        rendered = String(this)
      }
    }

    const root = new Context()
    await root.plugin(Bar)
    expect(rendered).to.equal(undefined)

    await root.plugin(Foo)
    expect(rendered).to.equal('Bar<bar>')
  })
})
