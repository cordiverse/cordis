import { Awaitable, defineProperty } from 'cosmokit'
import { Context } from './context.ts'

export class Service<C extends Context = Context> {
  static Context = Context

  protected start(): Awaitable<void> {}
  protected stop(): Awaitable<void> {}
  protected fork?(ctx: C, config: any): void

  protected ctx!: C
  protected [Context.current]!: C

  constructor(ctx: C | undefined, public name: string, immediate?: boolean) {
    this.ctx = ctx ?? new (this.constructor as any).Context()
    this.ctx.provide(name)
    defineProperty(this, Context.current, ctx)

    if (immediate) {
      if (ctx) this[Context.expose] = name
      else this.ctx[name] = this
    }

    this.ctx.on('ready', async () => {
      // await until next tick because derived class has not been initialized yet
      await Promise.resolve()
      await this.start()
      if (!immediate) this.ctx[name] = this
    })

    this.ctx.on('dispose', () => this.stop())
    return Context.associate(this, name)
  }

  [Context.filter](ctx: Context) {
    return ctx[Context.shadow][this.name] === this.ctx[Context.shadow][this.name]
  }
}
