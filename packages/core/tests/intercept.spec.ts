import { expect, describe, it } from 'vitest'
import { Context, Service } from '../src/index.ts'

interface Config {
  a?: number
  b?: number
  c?: number
  tags?: string[]
}

class Foo extends Service<Config> {
  constructor(ctx: Context) {
    super(ctx, 'foo')
  }

  config() {
    return this[Service.resolveIntercept]()
  }
}

class Bar extends Service {
  static inject = { foo: { a: 2 } }

  constructor(ctx: Context) {
    super(ctx, 'bar')
  }

  config() {
    return this.ctx.foo.config()
  }
}

describe('Intercept', () => {
  it('merge context intercepts from outer to inner', async () => {
    const root = new Context()
    await root.plugin(Foo)
    expect(root.foo.config()).to.deep.equal({})
    const ctx = root.intercept('foo', { a: 1, b: 1 }).intercept('foo', { b: 2 })
    expect(ctx.foo.config()).to.deep.equal({ a: 1, b: 2 })
  })

  it('merge injected config under context intercepts', async () => {
    const root = new Context()
    await root.plugin(Foo)
    let config!: Config
    await root.intercept('foo', { b: 2 }).inject({ foo: { a: 1, b: 1 } }, (ctx) => {
      config = ctx.intercept('foo', { c: 3 }).foo.config()
    })
    expect(config).to.deep.equal({ a: 1, b: 2, c: 3 })
  })

  it('take injected config from the declaring fiber', async () => {
    const root = new Context()
    await root.plugin(Foo)
    const configs: Config[] = []
    await root.inject({ foo: { a: 1 } }, async (ctx) => {
      // no declaration of its own, so the access is admitted by the outer fiber
      await ctx.plugin((ctx) => {
        configs.push(ctx.foo.config())
      })
      // the nearest declaration wins, and the outer one is not merged in
      await ctx.inject({ foo: { b: 2 } }, (ctx) => {
        configs.push(ctx.foo.config())
      })
    })
    expect(configs).to.deep.equal([{ a: 1 }, { b: 2 }])
  })

  it('stop looking for injected config at an isolation boundary', async () => {
    const root = new Context()
    await root.plugin(Foo)
    const label = Symbol('foo')
    await root.isolate('foo', label).plugin(Foo)
    let config!: Config
    await root.inject({ foo: { a: 1 } }, async (ctx) => {
      await ctx.plugin((ctx) => {
        config = ctx.isolate('foo', label).get('foo').config()
      })
    })
    expect(config).to.deep.equal({})
  })

  it('take injected config from the def site', async () => {
    const root = new Context()
    await root.plugin(Foo)
    await root.plugin(Bar)
    expect(root.intercept('foo', { b: 1 }).bar.config()).to.deep.equal({ a: 2, b: 1 })
  })

  it('custom merge', async () => {
    class Tagged extends Foo {
      [Service.mergeIntercept](...configs: Config[]) {
        return { tags: configs.flatMap(config => config.tags ?? []) }
      }
    }

    const root = new Context()
    await root.plugin(Tagged)
    let config!: Config
    await root.intercept('foo', { tags: ['outer'] }).inject({ foo: { tags: ['inject'] } }, (ctx) => {
      config = ctx.intercept('foo', { tags: ['inner'] }).foo.config()
    })
    expect(config).to.deep.equal({ tags: ['inject', 'outer', 'inner'] })
  })
})
