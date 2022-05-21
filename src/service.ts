import { Awaitable } from 'cosmokit'
import { Context } from './context'

export class Service {
  protected start(): Awaitable<void> {}
  protected stop(): Awaitable<void> {}

  constructor(protected ctx: Context, name: string, immediate?: boolean) {
    Context.service(name)

    if (immediate) {
      this[Context.immediate] = name
    }

    ctx.on('ready', async () => {
      await this.start()
      ctx[name] = this
    })

    ctx.on('dispose', async () => {
      ctx[name] = null
      await this.stop()
    })
  }

  get caller(): Context {
    return this[Context.current] || this.ctx
  }
}
