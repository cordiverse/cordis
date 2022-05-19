import { defineProperty } from 'cosmokit'
import { Services, Session } from '.'
import { App } from './app'
import { Lifecycle } from './lifecycle'
import { Plugin, Registry } from './plugin'

export type Filter = (session: Session) => boolean

export interface Context extends Services, Lifecycle.Delegates, Registry.Delegates {}

export class Context {
  static readonly current = Symbol('source')

  protected constructor(public filter: Filter, public app: App, public _plugin: Plugin) {}

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Context <${this._plugin ? this._plugin.name : 'root'}>`
  }

  fork(filter: Filter, _plugin: Plugin) {
    return new Context(filter, this.app, _plugin)
  }

  any() {
    return this.fork(() => true, this._plugin)
  }

  never() {
    return this.fork(() => false, this._plugin)
  }

  union(arg: Filter | Context) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return this.fork(s => this.filter(s) || filter(s), this._plugin)
  }

  intersect(arg: Filter | Context) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return this.fork(s => this.filter(s) && filter(s), this._plugin)
  }

  exclude(arg: Filter | Context) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return this.fork(s => this.filter(s) && !filter(s), this._plugin)
  }

  match(session?: Session) {
    return !session || this.filter(session)
  }

  get state() {
    return this.registry.get(this._plugin)
  }
}

export namespace Context {
  export interface ServiceOptions {
    constructor?: any
    methods?: string[]
  }

  /** @deprecated for backward compatibility */
  export interface Services {}

  export const internal = {}

  export function service(name: keyof any, options: ServiceOptions = {}) {
    if (Object.prototype.hasOwnProperty.call(Context.prototype, name)) return
    const privateKey = typeof name === 'symbol' ? name : Symbol(name)

    Object.defineProperty(Context.prototype, name, {
      get(this: Context) {
        const value = this.app[privateKey]
        if (!value) return
        defineProperty(value, Context.current, this)
        return value
      },
      set(this: Context, value) {
        const oldValue = this.app[privateKey]
        if (oldValue === value) return
        this.app[privateKey] = value
        if (typeof name !== 'string') return
        this.emit('service', name, oldValue)
        const action = value ? oldValue ? 'changed' : 'enabled' : 'disabled'
        this.emit('logger/debug', 'service', name, action)
      },
    })

    if (options.constructor) {
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
    methods: ['plugin', 'dispose'],
  })

  service('lifecycle', {
    constructor: Lifecycle,
    methods: ['on', 'once', 'off', 'before', 'after', 'parallel', 'emit', 'serial', 'bail', 'waterfall', 'chain'],
  })
}
