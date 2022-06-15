import { defineProperty } from 'cosmokit'
import { App } from './app'
import { Lifecycle } from './lifecycle'
import { Plugin } from './plugin'
import { Registry } from './registry'

export type Filter = (session: Lifecycle.Session) => boolean

export interface Context extends Context.Services, Context.Meta, Lifecycle.Delegates, Registry.Delegates {}

declare global {
  interface Object {
    [Context.filter]?(context: Context): boolean
  }
}

export class Context {
  static readonly filter = Symbol('filter')
  static readonly current = Symbol('source')
  static readonly immediate = Symbol('immediate')

  constructor(meta: Context.Meta) {
    Object.assign(this, meta)
  }

  get source() {
    const { plugin } = this.state.runtime
    if (!plugin) return 'root'
    return plugin?.name || 'anonymous'
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Context <${this.source}>`
  }

  extend(meta: Partial<Context.Meta>): this {
    return Object.assign(Object.create(this), meta)
  }

  localize(names: string[]) {
    const mapping = Object.create(this.mapping)
    for (const name of names) {
      mapping[name] = Symbol(name)
    }
    return this.extend({ mapping })
  }

  any() {
    return this.extend({ filter: () => true })
  }

  never() {
    return this.extend({ filter: () => false })
  }

  union(arg: Filter | Context) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return this.extend({ filter: s => this.filter(s) || filter(s) })
  }

  intersect(arg: Filter | Context) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return this.extend({ filter: s => this.filter(s) && filter(s) })
  }

  exclude(arg: Filter | Context) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return this.extend({ filter: s => this.filter(s) && !filter(s) })
  }

  match(session?: Lifecycle.Session) {
    return !session || this.filter(session)
  }
}

export namespace Context {
  /** @deprecated for backward compatibility */
  export interface Services {
    app: App
    lifecycle: Lifecycle
    registry: Registry
  }

  export const Services: string[] = []

  export interface ServiceOptions {
    constructor?: any
    methods?: string[]
  }

  export interface Meta {
    app: App
    state: Plugin.State
    filter: Filter
    mapping: {}
  }

  export const internal = Object.create(null)

  export function service(name: keyof any, options: ServiceOptions = {}) {
    if (Object.prototype.hasOwnProperty.call(Context.prototype, name)) return
    const privateKey = typeof name === 'symbol' ? name : Symbol(name)
    if (typeof name === 'string') Services.push(name)

    Object.defineProperty(Context.prototype, name, {
      get(this: Context) {
        const key = this.mapping[name] || privateKey
        const value = this.app[key]
        if (!value) return
        defineProperty(value, Context.current, this)
        return value
      },
      set(this: Context, value) {
        const key = this.mapping[name] || privateKey
        const oldValue = this.app[key]
        if (oldValue === value) return
        this.app[key] = value
        if (typeof name !== 'string') return

        // trigger event
        const self: Context = Object.create(this)
        self[Context.filter] = (ctx) => {
          return this.mapping[name] === ctx.mapping[name]
        }
        this.emit(self, 'internal/service', name, oldValue)
      },
    })

    if (Object.prototype.hasOwnProperty.call(options, 'constructor')) {
      internal[privateKey] = options.constructor
    }

    for (const method of options.methods || []) {
      defineProperty(Context.prototype, method, function (this: Context, ...args: any[]) {
        return this[name][method](...args)
      })
    }
  }

  service('registry', {
    constructor: Registry,
    methods: ['using', 'plugin', 'dispose'],
  })

  service('lifecycle', {
    constructor: Lifecycle,
    methods: ['on', 'once', 'off', 'before', 'after', 'parallel', 'emit', 'serial', 'bail', 'waterfall', 'chain'],
  })
}
