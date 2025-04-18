import { Context, Service } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'
import { Counter, getHookSnapshot, sleep } from './utils'

describe('Service', () => {
  it('pending inject', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }

      async [Service.init]() {
        await new Promise<void>((resolve, reject) => {
          this.ctx.on('custom-event', resolve)
        })
      }
    }

    const root = new Context()

    const callback = mock.fn()
    root.inject(['foo'], callback)
    expect(callback.mock.calls).to.have.length(0)

    // inject should be blocked by `Service.init`
    root.plugin(Foo)
    await sleep()
    expect(callback.mock.calls).to.have.length(0)

    root.emit('custom-event')
    await sleep()
    expect(callback.mock.calls).to.have.length(1)
  })

  it('traceable effect (with inject)', async () => {
    class Foo extends Service {
      static inject = ['counter']

      constructor(ctx: Context) {
        super(ctx, 'foo')
      }

      get value() {
        return this.ctx.counter.value
      }

      increase() {
        return this.ctx.counter.increase()
      }
    }

    const root = new Context()
    const warning = mock.fn()
    root.on('internal/warn', warning)
    root.provide('counter')
    root.set('counter', new Counter(root))

    await root.plugin(Foo)
    root.foo.increase()
    expect(root.foo.value).to.equal(1)
    expect(warning.mock.calls).to.have.length(0)

    const fiber = await root.inject(['foo'], (ctx) => {
      root.foo.increase()
      expect(ctx.foo.value).to.equal(2)
      expect(warning.mock.calls).to.have.length(0)
    })

    await fiber.dispose()
    root.foo.increase()
    expect(root.foo.value).to.equal(3)
    expect(warning.mock.calls).to.have.length(0)
  })

  it('traceable effect (without inject)', async () => {
    class Foo extends Service {
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }

      get value() {
        return this.ctx.counter.value
      }

      increase() {
        return this.ctx.counter.increase()
      }
    }

    const root = new Context()
    root.provide('counter')
    root.set('counter', new Counter(root))

    await root.plugin(Foo)
    root.foo.increase()
    expect(root.foo.value).to.equal(1)

    const fiber = await root.inject(['foo'], (ctx) => {
      root.foo.increase()
      expect(root.foo.value).to.equal(2)
    })

    await fiber.dispose()
    root.foo.increase()
    expect(root.foo.value).to.equal(3)
  })

  it('compare snapshot', async () => {
    class Test extends Service {
      constructor(ctx: Context) {
        super(ctx, 'test')
        ctx.inject(['test'], () => {})
      }
    }

    const root = new Context()
    const before = getHookSnapshot(root)
    await root.plugin(Test)
    const after = getHookSnapshot(root)
    root.registry.delete(Test)
    await sleep()
    expect(before).to.deep.equal(getHookSnapshot(root))
    root.plugin(Test)
    expect(after).to.deep.equal(getHookSnapshot(root))
  })

  it('multiple injects', async () => {
    const foo = mock.fn()
    const bar = mock.fn()
    const qux = mock.fn()

    class Foo extends Service {
      static inject = ['qux']
      constructor(ctx: Context) {
        super(ctx, 'foo')
      }
      [Service.init] = foo
    }

    class Bar extends Service {
      static inject = ['foo', 'qux']
      constructor(ctx: Context) {
        super(ctx, 'bar')
      }
      [Service.init] = bar
    }

    class Qux extends Service {
      constructor(ctx: Context) {
        super(ctx, 'qux')
      }
      [Service.init] = qux
    }

    const root = new Context()
    await root.plugin(Foo)
    await root.plugin(Bar)
    await root.plugin(Qux)
    await sleep()
    expect(foo.mock.calls).to.have.length(1)
    expect(bar.mock.calls).to.have.length(1)
    expect(qux.mock.calls).to.have.length(1)
  })
})
