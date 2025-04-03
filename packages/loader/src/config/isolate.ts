import { Context } from '@cordisjs/core'
import { Dict } from 'cosmokit'
import { Entry } from './entry.ts'

declare module './entry.ts' {
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

export default function isolate(ctx: Context) {
  const realms: Dict<GlobalRealm> = Object.create(null)

  function access(entry: Entry, name: string, create: true): symbol
  function access(entry: Entry, name: string, create?: boolean): symbol | undefined
  function access(entry: Entry, name: string, create = false) {
    let realm: Realm | undefined
    const label = entry.options.isolate?.[name]
    if (!label) return
    if (label === true) {
      realm = entry.realm ??= new LocalRealm(entry)
    } else if (create) {
      realm = realms[label] ??= new GlobalRealm(label)
    } else {
      realm = realms[label]
    }
    return realm?.access(name, create)
  }

  ctx.on('loader/entry-init', (entry) => {
    entry.ctx[Context.intercept] = Object.create(entry.ctx[Context.intercept])
    entry.ctx[Context.isolate] = Object.create(entry.ctx[Context.isolate])
  })

  ctx.on('loader/patch-context', (entry, next) => {
    // step 1: generate new isolate map
    const newMap: Dict<symbol> = Object.create(entry.parent.ctx[Context.isolate])
    for (const name of Object.keys(entry.options.isolate ?? {})) {
      newMap[name] = access(entry, name, true)
    }

    // step 2: generate service diff
    const diff: Dict<[symbol, symbol, symbol, symbol]> = Object.create(null)
    const oldMap = entry.ctx[Context.isolate]
    for (const name in { ...newMap, ...entry.loader.delims }) {
      if (newMap[name] === oldMap[name]) continue
      const delim = entry.loader.delims[name] ??= Symbol(`delim:${name}`)
      entry.ctx[delim] = Symbol(`${name}#${entry.id}`)
      for (const symbol of [oldMap[name], newMap[name]]) {
        const impl = symbol && entry.ctx.reflect.store[symbol]
        if (!impl) continue
        if (!impl.fiber) {
          entry.ctx.emit(entry.ctx, 'internal/warn', new Error(`expected service ${name} to be implemented`))
          continue
        }
        diff[name] = [oldMap[name], newMap[name], entry.ctx[delim], impl.fiber.ctx[delim]]
        if (entry.ctx[delim] !== impl.fiber.ctx[delim]) break
      }
    }

    // step 3: set prototype for transferred context
    Object.setPrototypeOf(entry.ctx[Context.isolate], entry.parent.ctx[Context.isolate])
    Object.setPrototypeOf(entry.ctx[Context.intercept], entry.parent.ctx[Context.intercept])
    swap(entry.ctx[Context.isolate], newMap)
    swap(entry.ctx[Context.intercept], entry.options.intercept)

    // step 4: reload fiber
    next()

    // step 5: replace service impl
    for (const [symbol1, symbol2, flag1, flag2] of Object.values(diff)) {
      if (flag1 === flag2 && entry.ctx.reflect.store[symbol1] && !entry.ctx.reflect.store[symbol2]) {
        entry.ctx.reflect.store[symbol2] = entry.ctx.reflect.store[symbol1]
        delete entry.ctx.reflect.store[symbol1]
      }
    }

    // step 6: reflect notify
    ctx.reflect.notify(Object.keys(diff), (ctx, name) => {
      const [symbol1, symbol2, flag1, flag2] = diff[name]
      const symbol3 = ctx[Context.isolate][name]
      const flag3 = ctx[entry.loader.delims[name]]
      return (symbol1 === symbol3 || symbol2 === symbol3) && (flag1 === flag3) !== (flag1 === flag2)
    })

    // step 7: clean up delimiters
    for (const name in entry.loader.delims) {
      if (!Reflect.ownKeys(newMap).includes(name)) {
        delete entry.ctx[entry.loader.delims[name]]
      }
    }
  })

  ctx.on('loader/partial-dispose', (entry, legacy, active) => {
    for (const [name, label] of Object.entries(legacy.isolate ?? {})) {
      if (label === true) continue
      if (active && entry.options.isolate?.[name] === label) continue
      const realm = realms[label]
      if (!realm) continue

      // realm garbage collection
      for (const entry of ctx.loader.entries()) {
        // has reference to this realm
        if (entry.options.isolate?.[name] === realm.label) return
      }
      realm.delete(name)
      if (!realm.size) {
        delete realms[realm.label]
      }
    }
  })
}
