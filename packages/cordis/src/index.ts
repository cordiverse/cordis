import * as core from '@cordisjs/core'
import { Logger, LoggerService } from '@cordisjs/logger'
import { TimerService } from '@cordisjs/timer'
import { defineProperty } from 'cosmokit'

export * from '@cordisjs/core'
export { default as Schema, default as z } from 'schemastery'
export { Logger } from '@cordisjs/logger'

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

export abstract class Service<C extends Context = Context> extends core.Service<C> {
  static Context = Context

  public logger!: Logger

  [core.Service.setup]() {
    this.ctx ??= new Context() as C
    defineProperty(this, Context.trace, this.ctx)
    this.logger = this.ctx.logger(this.name)
  }
}

export default function () {}
