import * as core from '@cordisjs/core'
import * as logger from '@cordisjs/logger'
import timer from '@cordisjs/timer'

export * from '@cordisjs/core'

export { Logger } from '@cordisjs/logger'

export class Service<C extends Context = Context> extends core.Service<C> {
  public logger: logger.Logger

  constructor(ctx: C, name: string, immediate?: boolean) {
    super(ctx, name, immediate)
    this.logger = ctx.logger(name)
  }
}

export class Context extends core.Context {
  constructor() {
    super()

    this.provide('logger', undefined, true)
    this.provide('timer', undefined, true)

    this.plugin(logger)
    this.plugin(timer)
  }
}

export default function () {}
