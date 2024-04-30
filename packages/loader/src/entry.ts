import { Context, ForkScope } from '@cordisjs/core'
import { Dict } from 'cosmokit'
import Loader from './shared.ts'

export namespace Entry {
  export interface Options {
    id: string
    name: string
    config?: any
    disabled?: boolean | null
    intercept?: Dict | null
    isolate?: Dict<boolean | string>
    when?: any
  }
}

function swapAssign<T extends {}>(target: T, source?: T | null): T {
  const result = { ...target }
  for (const key in result) {
    delete target[key]
  }
  Object.assign(target, source)
  return result
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
  public fork?: ForkScope
  public isUpdate = false
  public parent!: Context
  public options!: Entry.Options

  constructor(public loader: Loader) {}

  unlink() {
    const config = this.parent.config as Entry.Options[]
    const index = config.indexOf(this.options)
    if (index >= 0) config.splice(index, 1)
  }

  amend(ctx?: Context, initial = false) {
    ctx ??= this.parent.extend({
      [Context.intercept]: Object.create(this.parent[Context.intercept]),
      [Context.isolate]: Object.create(this.parent[Context.isolate]),
    })
    ctx.emit('loader/patch', this)
    swapAssign(ctx[Context.intercept], this.options.intercept)
    const neoMap: Dict<symbol> = Object.create(Object.getPrototypeOf(ctx[Context.isolate]))
    for (const [key, label] of Object.entries(this.options.isolate ?? {})) {
      if (typeof label === 'string') {
        neoMap[key] = (this.loader.realms[label] ??= Object.create(null))[key] ??= Symbol(key)
      } else if (label) {
        neoMap[key] = Symbol(key)
      }
    }
    // FIXME
    if (!initial) {
      for (const key in { ...ctx[Context.isolate], ...neoMap }) {
        if (neoMap[key] === ctx[Context.isolate][key]) continue
        const self = Object.create(null)
        self[Context.filter] = (ctx2: Context) => {
          return ctx[Context.isolate][key] === ctx2[Context.isolate][key]
        }
        ctx.emit(self, 'internal/before-service', key)
      }
    }
    const oldMap = swapAssign(ctx[Context.isolate], neoMap)
    if (!initial) {
      for (const key in { ...oldMap, ...ctx[Context.isolate] }) {
        if (oldMap[key] === ctx[Context.isolate][key]) continue
        const self = Object.create(null)
        self[Context.filter] = (ctx2: Context) => {
          return ctx[Context.isolate][key] === ctx2[Context.isolate][key]
        }
        ctx.emit(self, 'internal/service', key)
      }
    }
    return ctx
  }

  // TODO: handle parent change
  async update(parent: Context, options: Entry.Options) {
    this.parent = parent
    this.options = sortKeys(options)
    if (!this.loader.isTruthyLike(options.when) || options.disabled) {
      this.stop()
    } else if (this.fork) {
      this.isUpdate = true
      this.amend(this.fork.parent)
      this.fork.update(this.options.config)
    } else {
      this.parent.emit('loader/entry', 'apply', this)
      const plugin = await this.loader.resolve(this.options.name)
      if (!plugin) return
      const ctx = this.amend(undefined, true)
      this.fork = ctx.plugin(plugin, this.options.config)
      this.fork.entry = this
    }
  }

  stop() {
    this.fork?.dispose()
    this.fork = undefined
  }
}

Error.stackTraceLimit = 100
