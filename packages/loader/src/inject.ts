import { Context, EffectScope, Inject } from '@cordisjs/core'
import { Entry } from './entry.ts'

declare module './entry.ts' {
  interface EntryOptions {
    inject?: string[] | Inject | null
  }
}

export function apply(ctx: Context) {
  function getRequired(entry?: Entry) {
    return Array.isArray(entry?.options.inject)
      ? entry.options.inject
      : entry?.options.inject?.required ?? []
  }

  function getInject(entry?: Entry) {
    return Array.isArray(entry?.options.inject)
      ? entry?.options.inject
      : [
        ...entry?.options.inject?.required ?? [],
        ...entry?.options.inject?.optional ?? [],
      ]
  }

  const checkInject = (scope: EffectScope, name: string) => {
    if (!scope.runtime.plugin) return false
    if (scope.runtime === scope) {
      return scope.runtime.children.every(fork => checkInject(fork, name))
    }
    if (getInject(scope.entry).includes(name)) return true
    return checkInject(scope.parent.scope, name)
  }

  ctx.on('internal/inject', function (this, name) {
    return checkInject(this.scope, name)
  })

  ctx.on('loader/entry-check', (entry) => {
    for (const name of getRequired(entry)) {
      if (!entry.ctx.get(name)) return true
    }
  })

  ctx.on('internal/before-service', (name) => {
    for (const entry of ctx.loader.entries()) {
      if (!getRequired(entry).includes(name)) continue
      entry.refresh()
    }
  }, { global: true })

  ctx.on('internal/service', (name) => {
    for (const entry of ctx.loader.entries()) {
      if (!getRequired(entry).includes(name)) continue
      entry.refresh()
    }
  }, { global: true })
}
