import * as core from '@cordisjs/core'
import * as logger from '@cordisjs/logger'
import timer from '@cordisjs/timer'

export * from '@cordisjs/core'

export { Logger } from '@cordisjs/logger'

export type EffectScope<C extends Context = Context> = core.EffectScope<C>
export type ForkScope<C extends Context = Context> = core.ForkScope<C>
export type MainScope<C extends Context = Context> = core.MainScope<C>

export interface Events<C extends Context = Context> extends core.Events<C> {}

export class Service<C extends Context = Context> extends core.Service<C> {
  public logger: logger.Logger

  constructor(ctx: C, name: string, immediate?: boolean) {
    super(ctx, name, immediate)
    this.logger = ctx.logger(name)
  }
}

export namespace Context {
  export type Associate<P extends string, C extends Context = Context> = core.Context.Associate<P, C>
}

export class Context extends core.Context {
  baseDir: string

  constructor(config?: any) {
    super(config)
    this.baseDir = globalThis.process?.cwd() || ''

    this.provide('logger', undefined, true)
    this.provide('timer', undefined, true)

    this.plugin(logger)
    this.plugin(timer)
  }
}

export default function () {}
