import * as core from '@cordisjs/core'
import { Logger, LoggerService } from '@cordisjs/logger'
import { TimerService } from '@cordisjs/timer'

export * from '@cordisjs/core'
export { default as Schema, default as z } from 'schemastery'
export { Logger } from '@cordisjs/logger'
export { TimerService } from '@cordisjs/timer'

import { paramCase } from 'cosmokit'

export interface Events<C extends Context = Context> extends core.Events<C> {}

export namespace Context {
  export type Associate<P extends string, C extends Context = Context> = core.Context.Associate<P, C>
}

export interface Context {
  [Context.events]: Events<this>
}

export class Context extends core.Context {
  baseDir: string

  constructor(config?: any) {
    super(config)
    this.baseDir = globalThis.process?.cwd() || ''

    this.provide('logger', undefined, true)
    this.provide('timer', undefined, true)

    this.plugin(LoggerService)
    this.plugin(TimerService)
  }
}

export abstract class Service<T = unknown, C extends Context = Context> extends core.Service<T, C> {
  /** @deprecated use `this.ctx.logger` instead */
  public logger: Logger

  constructor(...args: core.Spread<T>)
  constructor(ctx: C, ...args: core.Spread<T>)
  constructor(ctx: C, name: string, immediate?: boolean)
  constructor(...args: any) {
    super(...args)
    this.logger = this.ctx.logger(paramCase(this.name))
  }

  [core.Service.setup]() {
    this.ctx = new Context() as C
  }
}

export default function () {}
