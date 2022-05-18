import { defineProperty } from 'cosmokit'
import Logger from 'reggol'
import { Services, Session } from '.'
import { Lifecycle } from './lifecycle'
import { Plugin, Registry } from './plugin'

export type Filter = (session: Session) => boolean

export interface Context extends Services, Lifecycle.Delegates, Registry.Delegates {}

export class Context {
  static readonly current = Symbol('source')

  public filter: Filter = () => true
  public services = {} as Services
  public _plugin: Plugin = null

  constructor(config: Context.Config = {}) {
    this.lifecycle = new Lifecycle(this, config)
    this.registry = new Registry(this, config)
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Context <${this._plugin ? this._plugin.name : 'root'}>`
  }

  logger(name: string) {
    return new Logger(name)
  }

  fork(filter: Filter, _plugin: Plugin) {
    const prototype = Object.getPrototypeOf(this)
    const context: this = Object.create(prototype)
    context.services = this.services
    context.filter = filter
    context._plugin = _plugin
    return context
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
  export interface Config extends Lifecycle.Config, Registry.Config {}

  export interface ServiceOptions {
    deprecated?: boolean
    methods?: string[]
  }

  const warnings = new Set<string>()

  export function service(name: keyof any, options: ServiceOptions = {}) {
    if (Object.prototype.hasOwnProperty.call(Context.prototype, name)) return
    Object.defineProperty(Context.prototype, name, {
      get(this: Context) {
        const value = this.services[name]
        if (!value) return
        if (options.deprecated && typeof name === 'string' && !warnings.has(name)) {
          warnings.add(name)
          this.logger('service').warn(`${name} is deprecated`)
        }
        defineProperty(value, Context.current, this)
        return value
      },
      set(this: Context, value) {
        const oldValue = this.services[name]
        if (oldValue === value) return
        this.services[name] = value
        if (typeof name !== 'string') return
        this.emit('service', name)
        const action = value ? oldValue ? 'changed' : 'enabled' : 'disabled'
        this.logger('service').debug(name, action)
      },
    })

    for (const method of options.methods || []) {
      defineProperty(Context.prototype, method, function (this: Context, ...args: any[]) {
        return this[name][method](...args)
      })
    }
  }

  service('registry', {
    methods: ['plugin', 'dispose'],
  })

  service('lifecycle', {
    methods: ['on', 'once', 'off', 'before', 'after', 'parallel', 'emit', 'serial', 'bail', 'waterfall', 'chain'],
  })
}
