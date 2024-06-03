import { Dict, remove } from 'cosmokit'
import { Context, Service } from '@cordisjs/core'
import Schema from 'schemastery'

export { default as Schema, default as z } from 'schemastery'

const kSchemaOrder = Symbol('cordis.schema.order')

declare module '@cordisjs/core' {
  interface Context {
    schema: SchemaService
  }

  interface Events {
    'internal/schema'(name: string): void
  }
}

export class SchemaService extends Service {
  _data: Dict<Schema> = Object.create(null)

  constructor(public ctx: Context) {
    super(ctx, 'schema', true)
  }

  extend(name: string, schema: Schema, order = 0) {
    const caller = this[Context.current]
    const target = this.get(name)
    const index = target.list.findIndex(a => a[kSchemaOrder] < order)
    schema[kSchemaOrder] = order
    if (index >= 0) {
      target.list.splice(index, 0, schema)
    } else {
      target.list.push(schema)
    }
    this.ctx.emit('internal/schema', name)
    caller.on('dispose', () => {
      remove(target.list, schema)
      this.ctx.emit('internal/schema', name)
    })
  }

  get(name: string) {
    return (this._data[name] ||= Schema.intersect([])) as Schema & { list: Schema[] }
  }

  set(name: string, schema: Schema) {
    const caller = this[Context.current]
    this._data[name] = schema
    this.ctx.emit('internal/schema', name)
    caller?.on('dispose', () => {
      delete this._data[name]
      this.ctx.emit('internal/schema', name)
    })
  }
}

export default SchemaService
