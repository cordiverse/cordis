import { defineProperty, remove } from 'cosmokit'
import Logger from 'reggol'
import { Hooks } from './hooks'
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

export type Filter<S> = (session: S) => boolean

export interface Context extends Context.Services {}

export class Context<S = never> {
  static readonly current = Symbol('source')

  protected constructor(public filter: Filter<S> = () => true, public root?: Context<S>, private _plugin: Plugin = null) {
    if (!root) root = this
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Context <${this._plugin ? this._plugin.name : 'root'}>`
  }

  logger(name: string) {
    return new Logger(name)
  }

  any() {
    return new Context<S>(() => true, this.root, this._plugin)
  }

  never() {
    return new Context<S>(() => false, this.root, this._plugin)
  }

  union(arg: Filter<S> | Context<S>) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return new Context<S>(s => this.filter(s) || filter(s), this.root, this._plugin)
  }

  intersect(arg: Filter<S> | Context<S>) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return new Context<S>(s => this.filter(s) && filter(s), this.root, this._plugin)
  }

  exclude(arg: Filter<S> | Context<S>) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return new Context<S>(s => this.filter(s) && !filter(s), this.root, this._plugin)
  }

  match(session?: S) {
    return !session || this.filter(session)
  }

  get state() {
    return this.registry.get(this._plugin)
  }

  using(using: readonly (keyof Context.Services)[], callback: Plugin.Function<void>) {
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

    const context = new Context(this.filter, this.root, plugin)
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
    this.hooks.emit('plugin-added', this.registry.get(plugin))

    if (using.length) {
      context.hooks.on('service', (name) => {
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
    this.hooks.emit('plugin-removed', state)
    return state
  }
}

export namespace Context {
  export interface Services {
    hooks: Hooks
    registry: Registry
  }

  export const Services: (keyof Services)[] = []

  export function service(key: keyof Services) {
    if (Object.prototype.hasOwnProperty.call(Context.prototype, key)) return
    Services.push(key)
    const privateKey = Symbol(key)
    Object.defineProperty(Context.prototype, key, {
      get(this: Context) {
        const value = this.root[privateKey]
        if (!value) return
        defineProperty(value, Context.current, this)
        return value
      },
      set(this: Context, value) {
        const oldValue = this.root[privateKey]
        if (oldValue === value) return
        this.root[privateKey] = value
        this.hooks.emit('service', key)
        const action = value ? oldValue ? 'changed' : 'enabled' : 'disabled'
        this.logger('service').debug(key, action)
      },
    })
  }
}
