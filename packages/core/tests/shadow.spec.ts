import { Context, Service, symbols } from '../src/index.ts'
import { describe, expect, it } from 'vitest'

describe('Traceable caller', () => {
  it('keeps caller metadata separate from the service shadow', async () => {
    let innerOrigin: Context
    let outerOrigin: Context

    class Inner extends Service {
      constructor(ctx: Context) {
        super(ctx, 'inner')
        innerOrigin = ctx
      }

      inspect() {
        return {
          caller: (this as any)[symbols.caller] as Context,
          shadow: this.ctx[symbols.shadow] as Context,
        }
      }
    }

    class Outer extends Service {
      static inject = ['inner']

      constructor(ctx: Context) {
        super(ctx, 'outer')
        outerOrigin = ctx
      }

      inspect() {
        const result = (this.ctx['inner'] as Inner).inspect()
        return {
          ...result,
          outerShadow: this.ctx[symbols.shadow] as Context,
        }
      }
    }

    const root = new Context()
    await root.use(Inner)
    await root.use(Outer)

    let result!: ReturnType<Outer['inspect']>
    await root.inject(['outer'], (ctx) => {
      result = ctx['outer'].inspect()
    })

    expect(result.caller).toBe(outerOrigin!)
    expect(result.shadow).toBe(innerOrigin!)
    expect(result.outerShadow).toBe(outerOrigin!)

    // accessing the service from root must not collapse the shadow
    const direct = root['outer'].inspect()
    expect(direct.caller).toBe(outerOrigin!)
    expect(direct.shadow).toBe(innerOrigin!)
    expect(direct.outerShadow).toBe(outerOrigin!)
  })

  it('applies the service inject when entered from root', async () => {
    class Inner extends Service {
      constructor(ctx: Context) {
        super(ctx, 'inner')
      }

      hello() {
        return 'hello'
      }
    }

    class Outer extends Service {
      // deliberately does not inject `inner`
      constructor(ctx: Context) {
        super(ctx, 'outer')
      }

      probe() {
        return (this.ctx['inner'] as Inner).hello()
      }
    }

    const root = new Context()
    await root.use(Inner)
    await root.use(Outer)

    const message = 'cannot get property "inner" without inject'
    expect(() => root['outer'].probe()).toThrow(message)
    await root.inject(['outer'], (ctx) => {
      expect(() => ctx['outer'].probe()).toThrow(message)
    })
  })

  it('resolves dependencies through a captured shadow', async () => {
    class Inner extends Service {
      constructor(ctx: Context) {
        super(ctx, 'inner')
      }

      hello() {
        return 'hello'
      }
    }

    // a plain object handed out by a service, capturing its `this.ctx`
    class Holder {
      [Service.tracker] = {
        property: 'ctx',
      }

      constructor(public ctx: Context) {}

      probe() {
        return [(this.ctx['outer'] as Outer).tag(), (this.ctx['inner'] as Inner).hello()]
      }

      depth() {
        let depth = 0
        let cursor: any = this.ctx
        while (cursor?.[symbols.shadow]) {
          depth += 1
          cursor = cursor[symbols.shadow]
        }
        return depth
      }
    }

    class Outer extends Service {
      static inject = ['inner']

      constructor(ctx: Context) {
        super(ctx, 'outer')
      }

      tag() {
        return 'outer'
      }

      create() {
        return new Holder(this.ctx)
      }
    }

    const root = new Context()
    await root.use(Inner)
    await root.use(Outer)

    // the holder's own ctx is a shadow, but the shadow it is accessed through
    // must stay exactly one level deep
    expect((root['outer'] as Outer).create().probe()).toEqual(['outer', 'hello'])
    expect((root['outer'] as Outer).create().depth()).toBe(1)
    await root.inject(['outer'], (ctx) => {
      expect((ctx['outer'] as Outer).create().probe()).toEqual(['outer', 'hello'])
      expect((ctx['outer'] as Outer).create().depth()).toBe(1)
    })
  })

  it('resolves same-name own provisions at their definition sites', async () => {
    const first = Symbol('first')
    const second = Symbol('second')
    class Probe extends Service {
      constructor(ctx: Context, public tag: string) {
        super(ctx, 'foo')
      }

      inspect() {
        return [this.ctx.foo.tag, this.ctx[Context.isolate].foo]
      }
    }

    class Relay extends Service {
      static inject = ['foo']

      constructor(ctx: Context) {
        super(ctx, 'relay')
      }

      inspect() {
        return this.ctx.foo.inspect()
      }
    }

    const root = new Context()
    await root.use((ctx) => {
      new Probe(ctx.isolate('foo', first), 'first')
      new Probe(ctx.isolate('foo', second), 'second')
    })
    await root.isolate('foo', first).use(Relay)
    // The use site changes, while the definition sites of the relay and the
    // probe it injects stay in the first realm.
    expect((root.isolate('foo', second)['relay'] as Relay).inspect()).toEqual(['first', second])
    expect(root.isolate('foo', second).foo.inspect()).toEqual(['second', second])
    await root.fiber.dispose()
  })

  it('keeps unchecked access for services provided on the root ctx', async () => {
    class Inner extends Service {
      constructor(ctx: Context) {
        super(ctx, 'inner')
      }

      hello() {
        return 'hello'
      }
    }

    // provided outside the fiber system, so it can never declare `inject`
    class Rooted {
      [Service.tracker] = {
        property: 'ctx',
      }

      constructor(public ctx: Context) {}

      probe() {
        return (this.ctx['inner'] as Inner).hello()
      }
    }

    const root = new Context()
    await root.use(Inner)
    root.provide('rooted', new Rooted(root))

    expect((root['rooted'] as Rooted).probe()).toBe('hello')
  })

  it('exposes the caller without preserving shadow for noShadow services', async () => {
    let outerOrigin: Context

    class Probe {
      [Service.tracker] = {
        property: 'ctx',
        noShadow: true,
      }

      constructor(public ctx: Context) {}

      inspect() {
        return {
          caller: (this as any)[symbols.caller] as Context,
          shadow: this.ctx[symbols.shadow] as Context | undefined,
        }
      }
    }

    class Outer extends Service {
      static inject = ['probe']

      constructor(ctx: Context) {
        super(ctx, 'outer')
        outerOrigin = ctx
      }

      inspect() {
        return (this.ctx['probe'] as Probe).inspect()
      }
    }

    const root = new Context()
    root.provide('probe', new Probe(root))
    await root.use(Outer)

    let result!: ReturnType<Outer['inspect']>
    await root.inject(['outer'], (ctx) => {
      result = ctx['outer'].inspect()
    })

    expect(result.caller).toBe(outerOrigin!)
    expect(result.shadow).toBeUndefined()
  })

  it('exposes the caller to callable services', async () => {
    let outerOrigin: Context

    interface Callable {
      (): Context
    }

    class Callable extends Service {
      constructor(ctx: Context) {
        super(ctx, 'callable')
      }

      protected [Service.invoke]() {
        return (this as any)[symbols.caller] as Context
      }
    }

    class Outer extends Service {
      static inject = ['callable']

      constructor(ctx: Context) {
        super(ctx, 'outer')
        outerOrigin = ctx
      }

      call() {
        return (this.ctx['callable'] as Callable)()
      }
    }

    const root = new Context()
    await root.use(Callable)
    await root.use(Outer)

    let caller!: Context
    await root.inject(['outer'], (ctx) => {
      caller = ctx['outer'].call()
    })

    expect(caller).toBe(outerOrigin!)
  })

  it('strips service shadow before creating components', async () => {
    class Loader extends Service {
      constructor(ctx: Context) {
        super(ctx, 'loader')
      }

      load(component: any) {
        return this.ctx.use(component)
      }
    }

    class Server extends Service {
      constructor(ctx: Context) {
        super(ctx, 'server')
      }
    }

    let injected = false
    function Consumer(ctx: Context) {
      return ctx.inject(['server'], ({ server }: any) => {
        injected = server instanceof Server
      })
    }

    const root = new Context()
    await root.use(Loader)
    await root.inject(['loader'], async (ctx) => {
      const loader = ctx['loader'] as any
      await loader.load(Server)
      await loader.load(Consumer)
    })

    expect(injected).toBe(true)
    expect(root.logger.buffer.filter(message => message.type === 'error')).toHaveLength(0)
  })
})

describe('Self-calling methods', () => {
  it('keep `this` one shadow deep however often they call themselves again', async () => {
    class Poller extends Service {
      count = 0
      sites: { shadow: Context, caller: Context }[] = []

      constructor(ctx: Context) {
        super(ctx, 'poller')
      }

      tick(left: number, done: (error?: unknown) => void) {
        try {
          this.count++
          if (left === 2000 || left === 0) {
            this.sites.push({ shadow: this.ctx[symbols.shadow] as Context, caller: (this as any)[symbols.caller] as Context })
          }
        } catch (error) {
          return done(error)
        }
        if (!left) return done()
        setImmediate(() => this.tick(left - 1, done))
      }
    }

    const root = new Context()
    await root.plugin(Poller)
    const error = await new Promise<unknown>((resolve) => root['poller'].tick(2000, resolve))
    expect(error).toBeUndefined()
    expect(root['poller'].count).toBe(2001)
    // the first round and the last see the same sites
    const [first, last] = root['poller'].sites
    expect(last.shadow).toBe(first.shadow)
    expect(last.caller).toBe(first.caller)
  })
})

