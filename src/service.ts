import { Awaitable } from 'cosmokit'
import { Context } from './context'

export class Service {
  protected start(): Awaitable<void> {}
  protected stop(): Awaitable<void> {}
  protected fork(ctx: Context, config: any) {}

  constructor(protected ctx: Context, name: string, immediate?: boolean) {
    Context.service(name)

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

    ctx.on('fork', (ctx, config) => {
      this.fork(ctx, config)
    })
  }

  get caller(): Context {
    return this[Context.current] || this.ctx
  }
}
