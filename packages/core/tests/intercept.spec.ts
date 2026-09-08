import { Context, Service } from '../src'
import { describe, expect, it } from 'vitest'

interface Config {
  base?: boolean
  head?: boolean
  source?: string
}

interface ConfigService {
  (head?: Config): Config
}

class ConfigService extends Service<Config> {
  constructor(ctx: Context) {
    super(ctx, 'config')
  }

  protected [Service.invoke](head?: Config) {
    return this[Service.resolveConfig]({ base: true }, head)
  }
}

describe('Service.resolveConfig', () => {
  it('resolves intercepts from the directly injecting fiber', async () => {
    const root = new Context()
    new ConfigService(root)

    let result!: Config
    await root.inject({ config: { source: 'inject' } }, (ctx) => {
      result = (ctx['config'] as ConfigService)({ head: true })
    })

    expect(result).toEqual({
      base: true,
      source: 'inject',
      head: true,
    })
  })

  it('ignores intercepts without a direct inject relation', () => {
    const root = new Context()
    new ConfigService(root)

    const ctx = root.intercept('config', { source: 'callsite' })
    expect((ctx['config'] as ConfigService)()).toEqual({ base: true })
  })

  it('inherits definition-site intercepts after the inject gate', async () => {
    const root = new Context()
    new ConfigService(root)

    const ctx = root.intercept('config', { source: 'definition' })
    let result!: Config
    await ctx.inject(['config'], (ctx) => {
      result = (ctx['config'] as ConfigService)()
    })

    expect(result).toEqual({ base: true, source: 'definition' })
  })

  it('uses each direct inject edge independently', async () => {
    class Middle extends Service {
      static inject = {
        config: { source: 'middle' },
      }

      constructor(ctx: Context) {
        super(ctx, 'middle')
      }

      call() {
        return (this.ctx['config'] as ConfigService)()
      }
    }

    class Outer extends Service {
      static inject = {
        middle: null,
        config: { source: 'outer' },
      }

      constructor(ctx: Context) {
        super(ctx, 'outer')
      }

      call() {
        return (this.ctx['middle'] as Middle).call()
      }
    }

    const root = new Context()
    new ConfigService(root)
    await root.plugin(Middle)
    await root.plugin(Outer)

    let result!: Config
    await root.inject({
      outer: null,
      config: { source: 'callsite' },
    }, (ctx) => {
      result = (ctx['outer'] as Outer).call()
    })

    expect(result).toEqual({ base: true, source: 'middle' })
  })

  it('does not apply definition-site intercepts without an inject edge', async () => {
    class Consumer extends Service {
      constructor(ctx: Context) {
        super(ctx, 'consumer')
      }

      call() {
        return (this.ctx['config'] as ConfigService)()
      }
    }

    const root = new Context()
    new ConfigService(root)
    await root.intercept('config', { source: 'definition' }).plugin(Consumer)

    let result!: Config
    await root.inject(['consumer'], (ctx) => {
      result = (ctx['consumer'] as Consumer).call()
    })

    expect(result).toEqual({ base: true })
  })

  it('honours inherited inject declarations', async () => {
    class BaseConsumer extends Service {
      static inject = {
        config: { source: 'base' },
      }

      constructor(ctx: Context) {
        super(ctx, 'consumer')
      }

      call() {
        return (this.ctx['config'] as ConfigService)()
      }
    }

    class Consumer extends BaseConsumer {}

    const root = new Context()
    new ConfigService(root)
    await root.plugin(Consumer)

    let result!: Config
    await root.inject(['consumer'], (ctx) => {
      result = (ctx['consumer'] as Consumer).call()
    })

    expect(result).toEqual({ base: true, source: 'base' })
  })
})
