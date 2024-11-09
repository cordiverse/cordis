import * as core from '@cordisjs/core'
import { LoggerService } from '@cordisjs/logger'
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

  constructor() {
    super()
    this.baseDir = globalThis.process?.cwd?.() || ''

    this.provide('logger', undefined, true)

    this.plugin(LoggerService)
  }
}

export abstract class Service<C extends Context = Context> extends core.Service<C> {
  public schema: SchemaService

  constructor(ctx: C, name: string) {
    super(ctx, name)
    this.schema = new SchemaService(this.ctx)
  }
}

export default function () {}
