import { Awaitable, defineProperty } from 'cosmokit'
import { Context } from './context'

export class Service<C extends Context = Context> {
  protected start(): Awaitable<void> {}
  protected stop(): Awaitable<void> {}
  protected fork?(ctx: C, config: any): void

  constructor(protected ctx: C, public name: string, immediate?: boolean) {
    ctx.root.provide(name)
    defineProperty(this, Context.current, ctx)

    if (immediate) {
      this[Context.expose] = name
    }

    ctx.on('ready', async () => {
      // await until next tick because derived class has not been initialized yet
      await Promise.resolve()
      await this.start()
      if (!immediate) ctx[name] = this
    })

    ctx.on('dispose', async () => {
      ctx[name] = undefined
      await this.stop()
    })
  }

  get caller() {
    return this[Context.current] as C
  }

  [Context.filter](ctx: Context) {
    return ctx[Context.shadow][this.name] === this.ctx[Context.shadow][this.name]
  }
}
