import { Awaitable, defineProperty } from 'cosmokit'
import { Context } from './context'

export class Service<C extends Context = Context> {
  protected start(): Awaitable<void> {}
  protected stop(): Awaitable<void> {}
  protected fork?(ctx: C, config: any): void

  constructor(protected ctx: C, name: string, immediate?: boolean) {
    Object.getPrototypeOf(ctx.root).constructor.service(name)
    defineProperty(this, Context.current, ctx)

    if (immediate) {
      this[Context.immediate] = name
    }

    ctx.on('ready', async () => {
      // await until next tick because derived class has not been initialized yet
      await Promise.resolve()
      await this.start()
      ctx[name] = this
    })

    ctx.on('dispose', async () => {
      ctx[name] = null
      await this.stop()
    })
  }

  get caller() {
    return this[Context.current] as C
  }
}
