import { remove } from 'cosmokit'
import Logger from 'reggol'
import { Session } from '.'
import { Lifecycle } from './lifecycle'
import { Plugin, Registry } from './plugin'

function isConstructor(func: Function) {
  // async function or arrow function
  if (!func.prototype) return false
  // generator function or malformed definition
  if (func.prototype.constructor !== func) return false
  return true
}

function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

export type Filter = (session: Session) => boolean

export interface Context extends Context.Services {}

export class Context {
  static readonly current = Symbol('source')

  public filter?: Filter
  public root?: Context
  private _plugin: Plugin

  static create(config: Context.Config = {}) {
    const root = new Context()
    root.filter = () => true
    root.root = root
    root._plugin = null
    root.lifecycle = new Lifecycle(root, config)
    root.registry = new Registry()
    return root
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Context <${this._plugin ? this._plugin.name : 'root'}>`
  }

  logger(name: string) {
    return new Logger(name)
  }

  private fork(filter: Filter, root: Context, _plugin: Plugin) {
    const prototype = Object.getPrototypeOf(this)
    const context: Context = Object.create(prototype)
    context.filter = filter
    context.root = root
    context._plugin = _plugin
    return context
  }

  any() {
    return this.fork(() => true, this.root, this._plugin)
  }

  never() {
    return this.fork(() => false, this.root, this._plugin)
  }

  union(arg: Filter | Context) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return this.fork(s => this.filter(s) || filter(s), this.root, this._plugin)
  }

  intersect(arg: Filter | Context) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return this.fork(s => this.filter(s) && filter(s), this.root, this._plugin)
  }

  exclude(arg: Filter | Context) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return this.fork(s => this.filter(s) && !filter(s), this.root, this._plugin)
  }

  match(session?: Session) {
    return !session || this.filter(session)
  }

  get state() {
    return this.registry.get(this._plugin)
  }

  using(using: readonly string[], callback: Plugin.Function<void>) {
    return this.plugin({ using, apply: callback, name: callback.name })
  }

  validate<T extends Plugin>(plugin: T, config: any) {
    if (config === false) return
    if (config === true) config = undefined
    config ??= {}

    const schema = plugin['Config'] || plugin['schema']
    if (schema) config = schema(config)
    return config
  }

  plugin<T extends Plugin>(plugin: T, config?: boolean | Plugin.Config<T>): this
  plugin(plugin: Plugin, config?: any) {
    // check duplication
    if (this.registry.has(plugin)) {
      this.logger('app').warn(`duplicate plugin detected: ${plugin.name}`)
      return this
    }

    // check if it's a valid plugin
    if (typeof plugin !== 'function' && !isApplicable(plugin)) {
      throw new Error('invalid plugin, expect function or object with an "apply" method')
    }

    // validate plugin config
    config = this.validate(plugin, config)
    if (!config) return this

    const context = this.fork(this.filter, this.root, plugin)
    const schema = plugin['Config'] || plugin['schema']
    const using = plugin['using'] || []

    this.logger('app').debug('plugin:', plugin.name)
    this.registry.set(plugin, {
      plugin,
      schema,
      using,
      context,
      id: Math.random().toString(36).slice(2, 10),
      parent: this,
      config: config,
      children: [],
      disposables: [],
    })

    this.state.children.push(plugin)
    this.lifecycle.emit('plugin-added', this.registry.get(plugin))

    if (using.length) {
      context.lifecycle.on('service', (name) => {
        if (!using.includes(name)) return
        context.state.children.slice().map(plugin => this.dispose(plugin))
        context.state.disposables.slice(1).map(dispose => dispose())
        callback()
      })
    }

    const callback = () => {
      if (using.some(name => !this[name])) return
      if (typeof plugin !== 'function') {
        plugin.apply(context, config)
      } else if (isConstructor(plugin)) {
        // eslint-disable-next-line new-cap
        new plugin(context, config)
      } else {
        plugin(context, config)
      }
    }

    callback()
    return this
  }

  dispose(plugin = this._plugin) {
    if (!plugin) throw new Error('root level context cannot be disposed')
    const state = this.registry.get(plugin)
    if (!state) return
    this.logger('app').debug('dispose:', plugin.name)
    state.children.slice().map(plugin => this.dispose(plugin))
    state.disposables.slice().map(dispose => dispose())
    this.registry.delete(plugin)
    remove(state.parent.state.children, plugin)
    this.lifecycle.emit('plugin-removed', state)
    return state
  }
}

export namespace Context {
  export interface Services {
    lifecycle: Lifecycle
    registry: Registry
  }

  export interface Config extends Lifecycle.Config {}

  // export const Services: (keyof Services)[] = []
}
