import { remove } from 'cosmokit'
import { Context } from './context'

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

export type Disposable = () => void

export type Plugin = Plugin.Function | Plugin.Object

export namespace Plugin {
  export type Function<T = any> = (ctx: Context, options: T) => void
  export type Constructor<T = any> = new (ctx: Context, options: T) => void

  export interface Object<T = any> {
    name?: string
    apply: Function<T>
    Config?: (config: T) => any
    schema?: (config: T) => any
    using?: readonly string[]
  }

  export type Config<T extends Plugin> =
    | T extends Constructor<infer U> ? U
    : T extends Function<infer U> ? U
    : T extends Object<infer U> ? U
    : never

  export interface State {
    id: string
    parent: Context
    context?: Context
    config?: any
    using: readonly string[]
    schema?: any
    plugin?: Plugin
    children: Plugin[]
    disposables: Disposable[]
  }
}

export namespace Registry {
  export interface Config {}

  export interface Delegates {
    plugin<T extends Plugin>(plugin: T, config?: boolean | Plugin.Config<T>): this
    dispose(): void
  }
}

export class Registry extends Map<Plugin, Plugin.State> {
  constructor(private ctx: Context, private config: Registry.Config) {
    super()
    this.set(null, {
      id: '',
      parent: null,
      using: [],
      children: [],
      disposables: [],
    })
  }

  protected get caller(): Context {
    return this[Context.current] || this.ctx
  }

  private resolve(plugin: Plugin) {
    return plugin && (typeof plugin === 'function' ? plugin : plugin.apply)
  }

  get(plugin: Plugin) {
    return super.get(this.resolve(plugin))
  }

  set(plugin: Plugin, state: Plugin.State) {
    return super.set(this.resolve(plugin), state)
  }

  has(plugin: Plugin) {
    return super.has(this.resolve(plugin))
  }

  delete(plugin: Plugin) {
    return super.delete(this.resolve(plugin))
  }

  using(using: readonly string[], callback: Plugin.Function<void>) {
    return this.plugin({ using, apply: callback, name: callback.name })
  }

  static validate(plugin: any, config: any) {
    if (config === false) return
    if (config === true) config = undefined
    config ??= {}

    const schema = plugin['Config'] || plugin['schema']
    if (schema) config = schema(config)
    return config
  }

  plugin(plugin: Plugin, config?: any) {
    // check duplication
    if (this.has(plugin)) {
      this.ctx.emit('logger/warn', 'app', `duplicate plugin detected: ${plugin.name}`)
      return this
    }

    // check if it's a valid plugin
    if (typeof plugin !== 'function' && !isApplicable(plugin)) {
      throw new Error('invalid plugin, expect function or object with an "apply" method')
    }

    // validate plugin config
    config = Registry.validate(plugin, config)
    if (!config) return this

    const context = this.caller.fork(this.caller.filter, plugin)
    const schema = plugin['Config'] || plugin['schema']
    const using = plugin['using'] || []

    this.ctx.emit('logger/debug', 'app', 'plugin:', plugin.name)
    this.set(plugin, {
      plugin,
      schema,
      using,
      context,
      id: Math.random().toString(36).slice(2, 10),
      parent: this.caller,
      config: config,
      children: [],
      disposables: [],
    })

    this.caller.state.children.push(plugin)
    this.caller.emit('plugin-added', this.get(plugin))

    if (using.length) {
      context.on('service', (name) => {
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

  dispose(plugin = this.caller._plugin) {
    if (!plugin) throw new Error('root level context cannot be disposed')
    const state = this.get(plugin)
    if (!state) return
    this.ctx.emit('logger/debug', 'app', 'dispose:', plugin.name)
    state.children.slice().map(plugin => this.dispose(plugin))
    state.disposables.slice().map(dispose => dispose())
    this.delete(plugin)
    remove(state.parent.state.children, plugin)
    this.caller.emit('plugin-removed', state)
    return state
  }
}
