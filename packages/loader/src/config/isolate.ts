import { Context } from '@cordisjs/core'
import { Dict } from 'cosmokit'
import { Entry } from './entry.ts'

declare module './entry.ts' {
  interface EntryUpdateMeta {
    newMap: Dict<symbol>
    diff: [string, symbol, symbol, symbol, symbol][]
  }

  interface EntryOptions {
    intercept?: Dict | null
    isolate?: Dict<true | string> | null
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

export const name = 'isolate'

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

  ctx.on('loader/entry-init', (entry) => {
    entry.ctx[Context.intercept] = Object.create(entry.ctx[Context.intercept])
    entry.ctx[Context.isolate] = Object.create(entry.ctx[Context.isolate])
  })

  ctx.on('loader/before-patch', function (entry) {
    // step 1: generate new isolate map
    this.newMap = Object.create(entry.parent.ctx[Context.isolate])
    for (const key of Object.keys(entry.options.isolate ?? {})) {
      this.newMap[key] = access(entry, key, true)
    }

    // step 2: generate service diff
    this.diff = []
    const oldMap = entry.ctx[Context.isolate]
    for (const key in { ...this.newMap, ...entry.loader.delims }) {
      if (this.newMap[key] === oldMap[key]) continue
      const delim = entry.loader.delims[key] ??= Symbol(`delim:${key}`)
      entry.ctx[delim] = Symbol(`${key}#${entry.id}`)
      for (const symbol of [oldMap[key], this.newMap[key]]) {
        const item = symbol && entry.ctx[Context.store][symbol]
        if (!item) continue
        if (!item.source) {
          entry.ctx.emit(entry.ctx, 'internal/warning', new Error(`expected service ${key} to be implemented`))
          continue
        }
        this.diff.push([key, oldMap[key], this.newMap[key], entry.ctx[delim], item.source[delim]])
        if (entry.ctx[delim] !== item.source[delim]) break
      }
    }

    // step 3: emit internal/before-service
    for (const [key, symbol1, symbol2, flag1, flag2] of this.diff) {
      const self = Object.create(entry.ctx)
      self[Context.filter] = (target: Context) => {
        if (![symbol1, symbol2].includes(target[Context.isolate][key])) return false
        return (flag1 === target[entry.loader.delims[key]]) !== (flag1 === flag2)
      }
      entry.ctx.emit(self, 'internal/before-service', key)
    }

    // step 4: set prototype for transferred context
    Object.setPrototypeOf(entry.ctx[Context.isolate], entry.parent.ctx[Context.isolate])
    Object.setPrototypeOf(entry.ctx[Context.intercept], entry.parent.ctx[Context.intercept])
    swap(entry.ctx[Context.isolate], this.newMap)
    swap(entry.ctx[Context.intercept], entry.options.intercept)
  })

  ctx.on('loader/after-patch', function (entry) {
    // step 5: replace service impl
    for (const [, symbol1, symbol2, flag1, flag2] of this.diff) {
      if (flag1 === flag2 && entry.ctx[Context.store][symbol1] && !entry.ctx[Context.store][symbol2]) {
        entry.ctx[Context.store][symbol2] = entry.ctx[Context.store][symbol1]
        delete entry.ctx[Context.store][symbol1]
      }
    }

    // step 6: emit internal/service
    for (const [key, symbol1, symbol2, flag1, flag2] of this.diff) {
      const self = Object.create(entry.ctx)
      self[Context.filter] = (target: Context) => {
        if (![symbol1, symbol2].includes(target[Context.isolate][key])) return false
        return (flag1 === target[entry.loader.delims[key]]) !== (flag1 === flag2)
      }
      entry.ctx.emit(self, 'internal/service', key)
    }

    // step 7: clean up delimiters
    for (const key in entry.loader.delims) {
      if (!Reflect.ownKeys(this.newMap).includes(key)) {
        delete entry.ctx[entry.loader.delims[key]]
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
}
