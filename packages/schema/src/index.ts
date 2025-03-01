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
    ctx.scope.inject.schema.config?.(ctx.scope.config)
    return true
  }
}

export default SchemaService
