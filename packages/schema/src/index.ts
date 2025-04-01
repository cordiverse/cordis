import { Context, Service } from 'cordis'
import Schema from 'schemastery'

export { default as Schema, default as z } from 'schemastery'

declare module 'cordis' {
  interface Intercept {
    schema: Schema
  }
}

export class SchemaService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'schema')
  }

  [Service.check](ctx: Context) {
    ctx.fiber.inject.schema.config?.(ctx.fiber.config)
    return true
  }
}

export default SchemaService
