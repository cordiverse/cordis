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
}
