import { Context, Service, symbols } from '../src'
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
    await root.plugin(Inner)
    await root.plugin(Outer)

    let result!: ReturnType<Outer['inspect']>
    await root.inject(['outer'], (ctx) => {
      result = ctx['outer'].inspect()
    })

    expect(result.caller).toBe(outerOrigin!)
    expect(result.shadow).toBe(innerOrigin!)
    expect(result.outerShadow).toBe(outerOrigin!)
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
    await root.plugin(Outer)

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
    await root.plugin(Callable)
    await root.plugin(Outer)

    let caller!: Context
    await root.inject(['outer'], (ctx) => {
      caller = ctx['outer'].call()
    })

    expect(caller).toBe(outerOrigin!)
  })

  it('strips service shadow before creating plugins', async () => {
    class Loader extends Service {
      constructor(ctx: Context) {
        super(ctx, 'loader')
      }

      load(plugin: any) {
        return this.ctx.plugin(plugin)
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
    await root.plugin(Loader)
    await root.inject(['loader'], async (ctx) => {
      const loader = ctx['loader'] as any
      await loader.load(Server)
      await loader.load(Consumer)
    })

    expect(injected).toBe(true)
    expect(root.logger.buffer.filter(message => message.type === 'error')).toHaveLength(0)
  })
})
