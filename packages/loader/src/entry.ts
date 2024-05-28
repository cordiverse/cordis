import { Context, ForkScope, Inject } from '@cordisjs/core'
import { Dict, isNullable } from 'cosmokit'
import { Loader } from './shared.ts'
import { EntryGroup } from './group.ts'

export namespace Entry {
  export interface Options {
    id: string
    name: string
    config?: any
    disabled?: boolean | null
    intercept?: Dict | null
    isolate?: Dict<true | string> | null
    inject?: string[] | Inject | null
    when?: any
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

function takeEntries(object: {}, keys: string[]) {
  const result: [string, any][] = []
  for (const key of keys) {
    if (!(key in object)) continue
    result.push([key, object[key]])
    delete object[key]
  }
  return result
}

function sortKeys<T extends {}>(object: T, prepend = ['id', 'name'], append = ['config']): T {
  const part1 = takeEntries(object, prepend)
  const part2 = takeEntries(object, append)
  const rest = takeEntries(object, Object.keys(object)).sort(([a], [b]) => a.localeCompare(b))
  return Object.assign(object, Object.fromEntries([...part1, ...rest, ...part2]))
}

export class Entry {
  static key = Symbol('cordis.entry')

  public fork?: ForkScope
  public suspend = false
  public options!: Entry.Options
  public children?: EntryGroup

  constructor(public loader: Loader, public parent: EntryGroup) {}

  resolveRealm(label: string | true) {
    if (label === true) {
      return '#' + this.options.id
    } else {
      return '@' + label
    }
  }

  patch(ctx: Context, ref: Context = ctx) {
    // part 1: prepare isolate map
    const newMap: Dict<symbol> = Object.create(Object.getPrototypeOf(ref[Context.isolate]))
    for (const [key, label] of Object.entries(this.options.isolate ?? {})) {
      const realm = this.resolveRealm(label)
      newMap[key] = (this.loader.realms[realm] ??= Object.create(null))[key] ??= Symbol(`${key}${realm}`)
    }

    // part 2: generate service diff
    const diff: [string, symbol, symbol, symbol, symbol][] = []
    const oldMap = ctx[Context.isolate]
    for (const key in { ...oldMap, ...newMap, ...this.loader.delims }) {
      if (newMap[key] === oldMap[key]) continue
      const delim = this.loader.delims[key] ??= Symbol(key)
      ctx[delim] = Symbol(`${key}#${this.options.id}`)
      for (const symbol of [oldMap[key], newMap[key]]) {
        const value = symbol && ctx[symbol]
        if (!(value instanceof Object)) continue
        const source = Reflect.getOwnPropertyDescriptor(value, Context.origin)?.value
        if (!source) {
          ctx.emit('internal/warning', new Error(`expected service ${key} to be implemented`))
          continue
        }
        diff.push([key, oldMap[key], newMap[key], ctx[delim], source[delim]])
        if (ctx[delim] !== source[delim]) break
      }
    }

    // part 3: emit service events
    // part 3.1: internal/before-service
    for (const [key, symbol1, symbol2, flag1, flag2] of diff) {
      const self = Object.create(ctx)
      self[Context.filter] = (target: Context) => {
        if (![symbol1, symbol2].includes(target[Context.isolate][key])) return false
        return (flag1 === target[this.loader.delims[key]]) !== (flag1 === flag2)
      }
      ctx.emit(self, 'internal/before-service', key)
    }

    // part 3.2: update service impl
    if (ctx === ref) {
      swap(ctx[Context.isolate], newMap)
      swap(ctx[Context.intercept], this.options.intercept)
      // prevent double update
      this.fork?.update(this.options.config)
    } else {
      // handle entry transfer
      Object.setPrototypeOf(ctx, Object.getPrototypeOf(ref))
      swap(ctx, ref)
    }
    for (const [, symbol1, symbol2, flag1, flag2] of diff) {
      if (flag1 === flag2 && ctx[symbol1] && !ctx[symbol2]) {
        ctx.root[symbol2] = ctx.root[symbol1]
        delete ctx.root[symbol1]
      }
    }

    // part 3.3: internal/service
    for (const [key, symbol1, symbol2, flag1, flag2] of diff) {
      const self = Object.create(ctx)
      self[Context.filter] = (target: Context) => {
        if (![symbol1, symbol2].includes(target[Context.isolate][key])) return false
        return (flag1 === target[this.loader.delims[key]]) !== (flag1 === flag2)
      }
      ctx.emit(self, 'internal/service', key)
    }

    // part 4: clean up delimiter
    for (const key in this.loader.delims) {
      if (!Reflect.ownKeys(newMap).includes(key)) {
        delete ctx[this.loader.delims[key]]
      }
    }
  }

  createContext() {
    return this.parent.ctx.extend({
      [Context.intercept]: Object.create(this.parent.ctx[Context.intercept]),
      [Context.isolate]: Object.create(this.parent.ctx[Context.isolate]),
    })
  }

  get requiredInjects() {
    return Array.isArray(this.options.inject)
      ? this.options.inject
      : this.options.inject?.required ?? []
  }

  get optionalInjects() {
    return Array.isArray(this.options.inject)
      ? this.options.inject
      : [
        ...this.options.inject?.required ?? [],
        ...this.options.inject?.optional ?? [],
      ]
  }

  _check() {
    if (!this.loader.isTruthyLike(this.options.when)) return false
    if (this.options.disabled) return false
    for (const name of this.requiredInjects) {
      let key = this.parent.ctx[Context.isolate][name]
      const label = this.options.isolate?.[name]
      if (label) {
        const realm = this.resolveRealm(label)
        key = (this.loader.realms[realm] ?? Object.create(null))[name] ?? Symbol(`${name}${realm}`)
      }
      if (!key || isNullable(this.parent.ctx[key])) return false
    }
    return true
  }

  async checkService(name: string) {
    if (!this.requiredInjects.includes(name)) return
    const ready = this._check()
    if (ready && !this.fork) {
      await this.start()
    } else if (!ready && this.fork) {
      await this.stop()
    }
  }

  async update(options: Entry.Options) {
    const legacy = this.options
    this.options = sortKeys(options)
    if (!this._check()) {
      await this.stop()
    } else if (this.fork) {
      this.suspend = true
      for (const [key, label] of Object.entries(legacy.isolate ?? {})) {
        if (this.options.isolate?.[key] === label) continue
        const name = this.resolveRealm(label)
        this.loader._clearRealm(key, name)
      }
      this.patch(this.fork.parent)
    } else {
      await this.start()
    }
  }

  async start() {
    const ctx = this.createContext()
    const exports = await this.loader.import(this.options.name, this.parent.url).catch((error: any) => {
      ctx.emit('internal/error', new Error(`Cannot find package "${this.options.name}"`))
      ctx.emit('internal/error', error)
    })
    if (!exports) return
    const plugin = this.loader.unwrapExports(exports)
    this.patch(ctx)
    ctx[Entry.key] = this
    this.fork = ctx.plugin(plugin, this.options.config)
    ctx.emit('loader/entry', 'apply', this)
  }

  async stop() {
    this.fork?.dispose()
    this.fork = undefined

    // realm garbage collection
    for (const [key, label] of Object.entries(this.options.isolate ?? {})) {
      const name = this.resolveRealm(label)
      this.loader._clearRealm(key, name)
    }
  }
}
