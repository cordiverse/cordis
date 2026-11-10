import { Context, Service } from '../src/index.ts'
import { expect, describe, it } from 'vitest'
import { mock } from 'node:test'
import { inspect } from 'util'
import { event, getHookSnapshot, sleep } from './utils.ts'

describe('Component', () => {
  it('apply functional component', async () => {
    const root = new Context()
    const callback = mock.fn()
    const options = { foo: 'bar' }
    await root.use(callback, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments[1]).to.deep.equal(options)
  })

  it('apply object component', async () => {
    const root = new Context()
    const callback = mock.fn()
    const options = { bar: 'foo' }
    const component = { apply: callback }
    await root.use(component, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments[1]).to.deep.equal(options)
  })

  it('apply component through deprecated ctx.plugin()', async () => {
    const root = new Context()
    const callback = mock.fn()
    const options = { foo: 'bar' }
    const fiber = await root.plugin(callback, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments[1]).to.deep.equal(options)
    expect(fiber.runtime).to.equal(root.registry.get(callback))
  })

  it('apply invalid component', async () => {
    const root = new Context()
    expect(() => root.use(undefined as any)).to.throw()
    expect(() => root.use({} as any)).to.throw()
    expect(() => root.use({ apply: {} } as any)).to.throw()
  })

  it('inactive context', async () => {
    const root = new Context()
    const callback = mock.fn()
    const fiber = root.use((ctx) => {
      return () => {
        expect(() => ctx.use(callback)).to.throw('inactive context')
        expect(() => ctx.effect(() => () => {})).to.throw('inactive context')
        expect(() => ctx.on('custom-event', () => {})).to.throw('inactive context')
      }
    })
    await fiber.dispose()
    expect(callback.mock.calls).to.have.length(0)
  })

  it('context inspect', async () => {
    const root = new Context()

    expect(inspect(root)).to.equal('Context <root>')

    await root.use((ctx) => {
      expect(inspect(ctx)).to.equal('Context <root>')
    })

    await root.use(function foo(ctx) {
      expect(inspect(ctx)).to.equal('Context <foo>')
    })

    await root.use({
      name: 'bar',
      apply: (ctx) => {
        expect(inspect(ctx)).to.equal('Context <bar>')
      },
    })

    await root.use(class Qux {
      constructor(ctx: Context) {
        expect(inspect(ctx)).to.equal('Context <Qux>')
      }
    })
  })

  it('ctx.registry', () => {
    // make coverage happy
    const root = new Context()
    root.registry.keys()
    root.registry.values()
    root.registry.entries()
    root.registry.forEach(() => {})
  })

  it('nested components', async () => {
    const component = async (ctx: Context) => {
      ctx.on(event, callback)
      await ctx.use(async (ctx) => {
        ctx.on(event, callback)
        await ctx.use((ctx) => {
          ctx.on(event, callback)
        })
      })
    }

    const root = new Context()
    const callback = mock.fn()
    root.on(event, callback)
    const fiber = await root.use(component)

    // 4 handlers by now
    expect(callback.mock.calls).to.have.length(0)
    expect(root.registry.size).to.equal(3)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(4)

    // only 1 handler left
    callback.mock.resetCalls()
    await fiber.dispose()
    expect(root.registry.size).to.equal(0)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)

    // subsequent calls should be noop
    callback.mock.resetCalls()
    await fiber.dispose()
    expect(root.registry.size).to.equal(0)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('compare snapshot', async () => {
    async function component(ctx: Context) {
      ctx.on(event, () => {})
      await ctx.use(async (ctx) => {
        ctx.on(event, () => {})
        await ctx.use((ctx) => {
          ctx.on(event, () => {})
        })
      })
    }

    const root = new Context()
    const before = getHookSnapshot(root)
    const fiber = await root.use(component)
    const after = getHookSnapshot(root)
    await fiber.dispose()
    expect(before).to.deep.equal(getHookSnapshot(root))
    await root.use(component)
    expect(after).to.deep.equal(getHookSnapshot(root))
  })

  it('root dispose', async () => {
    const root = new Context()
    const dispose = mock.fn()
    const fiber = root.use(() => dispose)
    expect(root.fiber.uid).to.equal(0)
    expect(fiber.uid).to.equal(1)
    expect(dispose.mock.calls).to.have.length(0)
    expect(root.fiber._disposables.length).to.equal(1)
    await root.fiber.dispose()
    expect(root.fiber.uid).to.equal(0)
    expect(fiber.uid).to.equal(null)
    expect(dispose.mock.calls).to.have.length(1)
    expect(root.fiber._disposables.length).to.equal(0)
    await root.fiber.dispose()
    expect(root.fiber.uid).to.equal(0)
    expect(fiber.uid).to.equal(null)
    expect(dispose.mock.calls).to.have.length(1)
    expect(root.fiber._disposables.length).to.equal(0)
  })
  
  it('Service.init', async () => {
    const start = mock.fn()
    const stop = mock.fn()

    class Foo {
      [Service.init]() {
        start()
        return stop
      }
    }

    const root = new Context()
    const fiber = await root.use(Foo)
    expect(start.mock.calls).to.have.length(1)
    expect(stop.mock.calls).to.have.length(0)
    await fiber.dispose()
    expect(start.mock.calls).to.have.length(1)
    expect(stop.mock.calls).to.have.length(1)
  })
})
