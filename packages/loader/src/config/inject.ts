import { Context, EffectScope, Inject } from '@cordisjs/core'
import { filterKeys } from 'cosmokit'
import { Entry } from './entry.ts'

declare module './entry.ts' {
  interface EntryOptions {
    inject?: Inject | null
  }
}

export const name = 'inject'

export function apply(ctx: Context) {
  function getRequired(entry: Entry) {
    return filterKeys(Inject.resolve(entry.options.inject), (_, meta) => meta.required)
  }

  const checkInject = (scope: EffectScope, name: string) => {
    if (!scope.runtime.plugin) return false
    if (scope.runtime === scope) {
      return scope.runtime.children.every(fork => checkInject(fork, name))
    }
    if (name in Inject.resolve(scope.entry?.options.inject)) return true
    return checkInject(scope.parent.scope, name)
  }

  ctx.on('internal/inject', function (this, name) {
    return checkInject(this.scope, name)
  })

  ctx.on('loader/entry-check', (entry) => {
    for (const name in getRequired(entry)) {
      if (!entry.ctx.get(name)) return true
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
