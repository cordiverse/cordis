import { defineProperty, remove } from 'cosmokit'
import { App } from './app'
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

  export interface Object<S = any, T = any> {
    name?: string
    apply: Function<T>
    reusable?: boolean
    Config?: (config?: S) => T
    schema?: (config?: S) => T
    using?: readonly string[]
  }

  export type Config<T extends Plugin> =
    | T extends Constructor<infer U> ? U
    : T extends Function<infer U> ? U
    : T extends Object<infer U> ? U
    : never

  export interface State {
    runtime: Runtime
    context: Context
    config: any
    disposables: Disposable[]
    dispose: () => void
  }

  const prevent = Symbol('prevent')

  export class Runtime {
    id = ''
    runtime = this
    context: Context
    schema: any
    using: readonly string[]
    disposables: Disposable[] = []
    forkers: Function[] = []
    children: State[] = []
    isActive = false

    constructor(private registry: Registry, public plugin: Plugin, public config: any) {
      this.fork(registry.caller, config)
      this.context = new Context((session) => {
        return this.children.some(p => p.context.match(session))
      }, registry.app, this)
      registry.set(plugin, this)

      if (plugin) this.start()
    }

    fork(context: Context, config: any) {
      const dispose = () => {
        state.disposables.splice(0, Infinity).forEach(dispose => dispose())
        remove(this.disposables, dispose)
        remove(context.state.disposables, dispose)
        if (remove(this.children, state) && !this.children.length) {
          this.dispose()
        }
      }
      dispose[prevent] = true
      defineProperty(dispose, 'name', `fork <${context.source}>`)
      const state: State = {
        runtime: this,
        config,
        context,
        disposables: [],
        dispose,
      }
      state.context = new Context(context.filter, context.app, state)
      this.children.push(state)
      this.disposables.push(dispose)
      context.state?.disposables.push(dispose)
      if (this.isActive) {
        this.executeFork(state)
      }
      return state
    }

    dispose() {
      this.disposables.splice(0, Infinity).forEach(dispose => dispose())
      this.registry.delete(this.plugin)
      this.context.emit('logger/debug', 'app', 'dispose:', this.plugin.name)
      this.context.emit('plugin-removed', this)
      return this
    }

    start() {
      this.schema = this.plugin['Config'] || this.plugin['schema']
      this.using = this.plugin['using'] || []
      this.id = Math.random().toString(36).slice(2, 10)
      this.registry.app.emit('plugin-added', this)
      this.registry.app.emit('logger/debug', 'app', 'plugin:', this.plugin.name)

      if (this.plugin['reusable']) {
        this.forkers.push(this.apply)
      }

      if (this.using.length) {
        const dispose = this.context.on('service', (name) => {
          if (!this.using.includes(name)) return
          this.disposables = this.disposables.filter(dispose => {
            if (dispose[prevent]) return true
            dispose()
          })
          this.callback()
        })
        dispose[prevent] = true
      }

      this.callback()
    }

    private executeFork(state: State) {
      for (const fork of this.forkers) {
        fork(state.context, state.config)
      }
    }

    private apply = (context: Context, config: any) => {
      if (typeof this.plugin !== 'function') {
        this.plugin.apply(context, config)
      } else if (isConstructor(this.plugin)) {
        // eslint-disable-next-line new-cap
        const instance = new this.plugin(context, config)
        const name = instance[Context.immediate]
        if (name) {
          context[name] = instance
        }
      } else {
        this.plugin(context, config)
      }
    }

    private callback() {
      if (this.using.some(name => !this.context[name])) return

      // execute plugin body
      if (!this.plugin['reusable']) {
        this.apply(this.context, this.config)
      }

      this.isActive = true
      for (const state of this.children) {
        this.executeFork(state)
      }
    }
  }
}

export namespace Registry {
  export interface Config {}

  export interface Delegates {
    using(using: readonly string[], callback: Plugin.Function<void>): this
    plugin<T extends Plugin>(plugin: T, config?: boolean | Plugin.Config<T>): this
    dispose(plugin?: Plugin): Plugin.Runtime
  }
}

export class Registry {
  #registry = new Map<Plugin, Plugin.Runtime>()

  constructor(public app: App, private config: Registry.Config) {
    app.state = new Plugin.Runtime(this, null, null)
  }

  get caller(): Context {
    return this[Context.current] || this.app
  }

  private resolve(plugin: Plugin) {
    return plugin && (typeof plugin === 'function' ? plugin : plugin.apply)
  }

  get(plugin: Plugin) {
    return this.#registry.get(this.resolve(plugin))
  }

  set(plugin: Plugin, state: Plugin.Runtime) {
    return this.#registry.set(this.resolve(plugin), state)
  }

  delete(plugin: Plugin) {
    return this.#registry.delete(this.resolve(plugin))
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
    const duplicate = this.get(plugin)
    if (duplicate) {
      duplicate.fork(this.caller, config)
      if (!duplicate.forkers.length) {
        this.app.emit('logger/warn', 'app', `duplicate plugin detected: ${plugin.name}`)
      }
      return this
    }

    // check if it's a valid plugin
    if (typeof plugin !== 'function' && !isApplicable(plugin)) {
      throw new Error('invalid plugin, expect function or object with an "apply" method')
    }

    // validate plugin config
    config = Registry.validate(plugin, config)
    if (!config) return this

    new Plugin.Runtime(this, plugin, config)
    return this
  }

  dispose(plugin: Plugin) {
    return this.get(plugin)?.dispose()
  }
}
