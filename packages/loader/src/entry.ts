import { Context, ForkScope } from '@cordisjs/core'
import { Dict } from 'cosmokit'
import Loader from './shared.ts'

export namespace Entry {
  export interface Options {
    id: string
    name: string
    config?: any
    disabled?: boolean
    intercept?: Dict
    isolate?: Dict<boolean | string>
    when?: any
  }
}

function swapAssign<T extends {}>(target: T, source?: T): T {
  const result = { ...target }
  for (const key in result) {
    delete target[key]
  }
  Object.assign(target, source)
  return result
}

export class Entry {
  public fork: ForkScope | null = null
  public isUpdate = false

  constructor(public loader: Loader, public parent: Context, public options: Entry.Options) {}

  amend(ctx: Context) {
    swapAssign(ctx[Context.intercept], this.options.intercept)
    const neoMap: Dict<symbol> = Object.create(Object.getPrototypeOf(ctx[Context.isolate]))
    for (const [key, label] of Object.entries(this.options.isolate ?? {})) {
      if (typeof label === 'string') {
        neoMap[key] = (this.loader.realms[label] ??= Object.create(null))[key] ??= Symbol(key)
      } else if (label) {
        neoMap[key] = Symbol(key)
      }
    }
    for (const key in { ...ctx[Context.isolate], ...neoMap }) {
      if (neoMap[key] === ctx[Context.isolate][key]) continue
      const self = Object.create(null)
      self[Context.filter] = (ctx2: Context) => {
        return ctx[Context.isolate][key] === ctx2[Context.isolate][key]
      }
      ctx.emit(self, 'internal/before-service', key)
    }
    const oldMap = swapAssign(ctx[Context.isolate], neoMap)
    for (const key in { ...oldMap, ...ctx[Context.isolate] }) {
      if (oldMap[key] === ctx[Context.isolate][key]) continue
      const self = Object.create(null)
      self[Context.filter] = (ctx2: Context) => {
        return ctx[Context.isolate][key] === ctx2[Context.isolate][key]
      }
      ctx.emit(self, 'internal/service', key)
    }
  }

  // TODO: handle parent change
  update(parent: Context, options: Entry.Options) {
    this.options = options
    if (!this.loader.isTruthyLike(options.when) || options.disabled) {
      this.stop()
    } else {
      this.start()
    }
  }

  async start() {
    if (this.fork) {
      this.isUpdate = true
      this.amend(this.fork.parent)
      this.fork.update(this.options.config)
    } else {
      this.parent.emit('loader/entry', 'apply', this)
      const plugin = await this.loader.resolve(this.options.name)
      if (!plugin) return
      const ctx = this.parent.extend({
        [Context.intercept]: Object.create(this.parent[Context.intercept]),
        [Context.isolate]: Object.create(this.parent[Context.isolate]),
      })
      this.amend(ctx)
      this.fork = ctx.plugin(plugin, this.loader.interpolate(this.options.config))
      this.fork.entry = this
    }
  }

  stop() {
    if (!this.fork) return
    this.parent.emit('loader/entry', 'unload', this)
    this.fork.dispose()
    this.fork = null
  }
}
