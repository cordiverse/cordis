import { defineProperty, remove } from 'cosmokit'
import { Context, Service } from '@cordisjs/core'
import Schema from 'schemastery'

export { default as Schema, default as z } from 'schemastery'

const kSchemaOrder = Symbol('cordis.schema.order')

declare module '@cordisjs/core' {
  interface Events {
    'internal/service-schema'(): void
  }
}

export class SchemaService {
  _data = Schema.intersect([]) as Schema & { list: Schema[] }

  constructor(public ctx: Context) {
    defineProperty(this, Service.tracker, {
      property: 'ctx',
    })
  }

  extend(schema: Schema, order = 0) {
    const index = this._data.list.findIndex(a => a[kSchemaOrder] < order)
    schema[kSchemaOrder] = order
    return this.ctx.effect(() => {
      if (index >= 0) {
        this._data.list.splice(index, 0, schema)
      } else {
        this._data.list.push(schema)
      }
      this.ctx.emit('internal/service-schema')
      return () => {
        remove(this._data.list, schema)
        this.ctx.emit('internal/service-schema')
      }
    })
  }

  toJSON() {
    return this._data.toJSON()
  }
}

export default SchemaService
