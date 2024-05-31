import { Context, EffectScope, Inject } from '@cordisjs/core'
import { Dict, isNullable } from 'cosmokit'
import { Entry } from './entry.ts'

declare module './entry.ts' {
  interface EntryUpdateMeta {
    newMap: Dict<symbol>
    diff: [string, symbol, symbol, symbol, symbol][]
  }

  interface EntryOptions {
    intercept?: Dict | null
    isolate?: Dict<true | string> | null
    inject?: string[] | Inject | null
  }

  interface Entry {
    realm: LocalRealm
  }
}

function swap<T extends {}>(target: T, source?: T | null) {
  for (const key of Reflect.ownKeys(target)) {
    Reflect.deleteProperty(target, key)
  }
  for (const key of Reflect.ownKeys(source || {})) {
    Reflect.defineProperty(target, key, Reflect.getOwnPropertyDescriptor(source!, key)!)
  }
}

export abstract class Realm {
  protected store: Dict<symbol> = Object.create(null)

  abstract get suffix(): string

  access(key: string, create = false) {
    if (create) {
      return this.store[key] ??= Symbol(`${key}${this.suffix}`)
    } else {
      return this.store[key] ?? Symbol(`${key}${this.suffix}`)
    }
  }

  delete(key: string) {
    delete this.store[key]
  }

  get size() {
    return Object.keys(this.store).length
  }
}

export class LocalRealm extends Realm {
  constructor(private entry: Entry) {
    super()
  }

  get suffix() {
    return '#' + this.entry.options.id
  }
}

export class GlobalRealm extends Realm {
  constructor(public label: string) {
    super()
  }

  get suffix() {
    return '@' + this.label
  }
}

export function apply(ctx: Context) {
  const realms: Dict<GlobalRealm> = Object.create(null)

  function access(entry: Entry, key: string, create: true): symbol
  function access(entry: Entry, key: string, create?: boolean): symbol | undefined
  function access(entry: Entry, key: string, create = false) {
    let realm: Realm | undefined
    const label = entry.options.isolate?.[key]
    if (!label) return
    if (label === true) {
      realm = entry.realm ??= new LocalRealm(entry)
    } else if (create) {
      realm = realms[label] ??= new GlobalRealm(label)
    } else {
      realm = realms[label]
    }
    return realm?.access(key, create)
  }

  ctx.on('loader/context-init', (entry, ctx) => {
    ctx[Context.intercept] = Object.create(entry.parent.ctx[Context.intercept])
    ctx[Context.isolate] = Object.create(entry.parent.ctx[Context.isolate])
  })

  ctx.on('loader/before-patch', function (entry, ctx) {
    // step 1: generate new isolate map
    this.newMap = Object.create(entry.parent.ctx[Context.isolate])
    for (const key of Object.keys(entry.options.isolate ?? {})) {
      this.newMap[key] = access(entry, key, true)
    }

    // step 2: generate service diff
    this.diff = []
    const oldMap = ctx[Context.isolate]
    for (const key in { ...this.newMap, ...entry.loader.delims }) {
      if (this.newMap[key] === oldMap[key]) continue
      const delim = entry.loader.delims[key] ??= Symbol(`delim:${key}`)
      ctx[delim] = Symbol(`${key}#${entry.id}`)
      for (const symbol of [oldMap[key], this.newMap[key]]) {
        const value = symbol && ctx[symbol]
        if (!(value instanceof Object)) continue
        const source = Reflect.getOwnPropertyDescriptor(value, Context.origin)?.value
        if (!source) {
          ctx.emit('internal/warning', new Error(`expected service ${key} to be implemented`))
          continue
        }
        this.diff.push([key, oldMap[key], this.newMap[key], ctx[delim], source[delim]])
        if (ctx[delim] !== source[delim]) break
      }
    }

    // step 3: emit internal/before-service
    for (const [key, symbol1, symbol2, flag1, flag2] of this.diff) {
      const self = Object.create(ctx)
      self[Context.filter] = (target: Context) => {
        if (![symbol1, symbol2].includes(target[Context.isolate][key])) return false
        return (flag1 === target[entry.loader.delims[key]]) !== (flag1 === flag2)
      }
      ctx.emit(self, 'internal/before-service', key)
    }

    // step 4: set prototype for transferred context
    Object.setPrototypeOf(ctx[Context.isolate], entry.parent.ctx[Context.isolate])
    Object.setPrototypeOf(ctx[Context.intercept], entry.parent.ctx[Context.intercept])
    swap(ctx[Context.isolate], this.newMap)
    swap(ctx[Context.intercept], entry.options.intercept)
  })

  ctx.on('loader/after-patch', function (entry, ctx) {
    // step 5: replace service impl
    for (const [, symbol1, symbol2, flag1, flag2] of this.diff) {
      if (flag1 === flag2 && ctx[symbol1] && !ctx[symbol2]) {
        ctx.root[symbol2] = ctx.root[symbol1]
        delete ctx.root[symbol1]
      }
    }

    // step 6: emit internal/service
    for (const [key, symbol1, symbol2, flag1, flag2] of this.diff) {
      const self = Object.create(ctx)
      self[Context.filter] = (target: Context) => {
        if (![symbol1, symbol2].includes(target[Context.isolate][key])) return false
        return (flag1 === target[entry.loader.delims[key]]) !== (flag1 === flag2)
      }
      ctx.emit(self, 'internal/service', key)
    }

    // step 7: clean up delimiters
    for (const key in entry.loader.delims) {
      if (!Reflect.ownKeys(this.newMap).includes(key)) {
        delete ctx[entry.loader.delims[key]]
      }
    }
  })

  ctx.on('loader/partial-dispose', (entry, legacy, active) => {
    for (const [key, label] of Object.entries(legacy.isolate ?? {})) {
      if (label === true) continue
      if (active && entry.options.isolate?.[key] === label) continue
      const realm = realms[label]
      if (!realm) continue

      // realm garbage collection
      for (const entry of ctx.loader.entries()) {
        // has reference to this realm
        if (entry.options.isolate?.[key] === realm.label) return
      }
      realm.delete(key)
      if (!realm.size) {
        delete realms[realm.label]
      }
    }
  })

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
      let key: symbol | undefined = entry.parent.ctx[Context.isolate][name]
      const label = entry.options.isolate?.[name]
      if (label) key = access(entry, name)
      if (!key || isNullable(entry.parent.ctx[key])) return true
    }
  })

  ctx.on('internal/before-service', (name) => {
    for (const entry of ctx.loader.entries()) {
      if (!getRequired(entry).includes(name)) return
      entry.refresh()
    }
  }, { global: true })

  ctx.on('internal/service', (name) => {
    for (const entry of ctx.loader.entries()) {
      if (!getRequired(entry).includes(name)) return
      entry.refresh()
    }
  }, { global: true })
}
