import * as core from '@cordisjs/core'
import { Logger, LoggerService } from '@cordisjs/logger'
import { SchemaService } from '@cordisjs/schema'

export * from '@cordisjs/core'
export { Schema, z } from '@cordisjs/schema'
export { Logger } from '@cordisjs/logger'

export interface Events<C extends Context = Context> extends core.Events<C> {}

export interface Context {
  [Context.events]: Events<this>
}

export class Context extends core.Context {
  baseDir: string

  constructor(config?: any) {
    super(config)
    this.baseDir = globalThis.process?.cwd?.() || ''

    this.provide('logger', undefined, true)

    this.plugin(LoggerService)
  }
}

export abstract class Service<C extends Context = Context> extends core.Service<C> {
  /** @deprecated use `this.ctx.logger` instead */
  public logger: Logger
  public schema: SchemaService

  constructor(ctx: C, name: string) {
    super(ctx, name)
    this.logger = this.ctx.logger(this.name)
    this.schema = new SchemaService(this.ctx)
  }
}

export default function () {}
