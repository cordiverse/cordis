import { Context, ForkScope, Inject } from '@cordisjs/core'
import { Dict, isNullable } from 'cosmokit'
import { Loader } from './loader.ts'
import { EntryGroup } from './group.ts'
import { EntryTree } from './tree.ts'

export namespace Entry {
  export interface Options {
    id: string
    name: string
    config?: any
    group?: boolean | null
    disabled?: boolean | null
    intercept?: Dict | null
    isolate?: Dict<true | string> | null
    inject?: string[] | Inject | null
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
  static readonly key = Symbol.for('cordis.entry')

  public fork?: ForkScope
  public suspend = false
  public options!: Entry.Options
  public subgroup?: EntryGroup
  public subtree?: EntryTree

  constructor(public loader: Loader, public parent: EntryGroup) {}

  get id() {
    let id = this.options.id
    if (this.parent.tree.ctx.scope.entry) {
      id = this.parent.tree.ctx.scope.entry.id + EntryTree.sep + id
    }
    return id
  }

  get requiredDeps() {
    return Array.isArray(this.options.inject)
      ? this.options.inject
      : this.options.inject?.required ?? []
  }

  get deps() {
    return Array.isArray(this.options.inject)
      ? this.options.inject
      : [
        ...this.options.inject?.required ?? [],
        ...this.options.inject?.optional ?? [],
      ]
  }

  get disabled() {
    // group is always enabled
    if (this.options.group) return false
    let entry: Entry | undefined = this
    do {
      if (entry.options.disabled) return true
      entry = entry.parent.ctx.scope.entry
    } while (entry)
    return false
  }

  _check() {
    if (this.disabled) return false
    for (const name of this.requiredDeps) {
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
    if (!this.requiredDeps.includes(name)) return
    const ready = this._check()
    if (ready && !this.fork) {
      await this.start()
    } else if (!ready && this.fork) {
      await this.stop()
    }
  }

  resolveRealm(label: string | true) {
    if (label === true) {
      return '#' + this.id
    } else {
      return '@' + label
    }
  }

  hasIsolate(key: string, realm: string) {
    if (!this.fork) return false
    const label = this.options.isolate?.[key]
    if (!label) return false
    return realm === this.resolveRealm(label)
  }

  patch(options: Partial<Entry.Options> = {}) {
    // step 1: prepare isolate map
    const ctx = this.fork?.parent ?? this.parent.ctx.extend({
      [Context.intercept]: Object.create(this.parent.ctx[Context.intercept]),
      [Context.isolate]: Object.create(this.parent.ctx[Context.isolate]),
    })
    const newMap: Dict<symbol> = Object.create(this.parent.ctx[Context.isolate])
    for (const [key, label] of Object.entries(this.options.isolate ?? {})) {
      const realm = this.resolveRealm(label)
      newMap[key] = (this.loader.realms[realm] ??= Object.create(null))[key] ??= Symbol(`${key}${realm}`)
    }

    // step 2: generate service diff
    const diff: [string, symbol, symbol, symbol, symbol][] = []
    const oldMap = ctx[Context.isolate]
    for (const key in { ...oldMap, ...newMap, ...this.loader.delims }) {
      if (newMap[key] === oldMap[key]) continue
      const delim = this.loader.delims[key] ??= Symbol(`delim:${key}`)
      ctx[delim] = Symbol(`${key}#${this.id}`)
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

    // step 3: emit internal/before-service
    for (const [key, symbol1, symbol2, flag1, flag2] of diff) {
      const self = Object.create(ctx)
      self[Context.filter] = (target: Context) => {
        if (![symbol1, symbol2].includes(target[Context.isolate][key])) return false
        return (flag1 === target[this.loader.delims[key]]) !== (flag1 === flag2)
      }
      ctx.emit(self, 'internal/before-service', key)
    }

    // step 4: update
    // step 4.1: patch context
    Object.setPrototypeOf(ctx, this.parent.ctx)
    Object.setPrototypeOf(ctx[Context.isolate], this.parent.ctx[Context.isolate])
    Object.setPrototypeOf(ctx[Context.intercept], this.parent.ctx[Context.intercept])
    swap(ctx[Context.isolate], newMap)
    swap(ctx[Context.intercept], this.options.intercept)

    // step 4.2: update fork (only when options.config is updated)
    if (this.fork && 'config' in options) {
      this.suspend = true
      this.fork.update(this.options.config)
    } else if (this.subgroup && 'disabled' in options) {
      const tree = this.subtree ?? this.parent.tree
      for (const options of this.subgroup.data) {
        tree.store[options.id].update({
          disabled: options.disabled,
        })
      }
    }

    // step 4.3: replace service impl
    for (const [, symbol1, symbol2, flag1, flag2] of diff) {
      if (flag1 === flag2 && ctx[symbol1] && !ctx[symbol2]) {
        ctx.root[symbol2] = ctx.root[symbol1]
        delete ctx.root[symbol1]
      }
    }

    // step 5: emit internal/service
    for (const [key, symbol1, symbol2, flag1, flag2] of diff) {
      const self = Object.create(ctx)
      self[Context.filter] = (target: Context) => {
        if (![symbol1, symbol2].includes(target[Context.isolate][key])) return false
        return (flag1 === target[this.loader.delims[key]]) !== (flag1 === flag2)
      }
      ctx.emit(self, 'internal/service', key)
    }

    // step 6: clean up delimiters
    for (const key in this.loader.delims) {
      if (!Reflect.ownKeys(newMap).includes(key)) {
        delete ctx[this.loader.delims[key]]
      }
    }

    return ctx
  }

  async update(options: Partial<Entry.Options>, override = false) {
    const legacy = { ...this.options }

    // step 1: update options
    if (override) {
      this.options = options as Entry.Options
    } else {
      for (const [key, value] of Object.entries(options)) {
        if (isNullable(value)) {
          delete this.options[key]
        } else {
          this.options[key] = value
        }
      }
    }
    sortKeys(this.options)

    // step 2: execute
    if (!this._check()) {
      await this.stop()
    } else if (this.fork) {
      for (const [key, label] of Object.entries(legacy.isolate ?? {})) {
        if (this.options.isolate?.[key] === label) continue
        const name = this.resolveRealm(label)
        this.loader._clearRealm(key, name)
      }
      this.patch(options)
    } else {
      await this.start()
    }
  }

  async start() {
    const exports = await this.parent.tree.import(this.options.name).catch((error: any) => {
      this.parent.ctx.emit('internal/error', new Error(`Cannot find package "${this.options.name}"`))
      this.parent.ctx.emit('internal/error', error)
    })
    if (!exports) return
    const plugin = this.loader.unwrapExports(exports)
    const ctx = this.patch()
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
