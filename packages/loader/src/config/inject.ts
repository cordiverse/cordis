import { Context, Inject } from '@cordisjs/core'
import { filterKeys, isNullable } from 'cosmokit'
import { Entry } from './entry.ts'

declare module './entry.ts' {
  interface EntryOptions {
    inject?: Inject | null
  }
}

export default function inject(ctx: Context) {
  function getRequired(entry: Entry) {
    return filterKeys(Inject.resolve(entry.options.inject), (_, meta) => meta!.required)
  }

  ctx.on('loader/entry-check', (entry) => {
    for (const name in getRequired(entry)) {
      if (isNullable(entry.ctx.get(name, true))) return true
    }
  })

  ctx.on('internal/before-service', (name) => {
    for (const entry of ctx.loader.entries()) {
      if (!(name in getRequired(entry))) continue
      entry.refresh()
    }
  }, { global: true })

  ctx.on('internal/service', (name) => {
    for (const entry of ctx.loader.entries()) {
      if (!(name in getRequired(entry))) continue
      entry.refresh()
    }
  }, { global: true })
}
