import { App } from './app'
import { Context } from './context'
import { Plugin } from './plugin'

function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

export namespace Registry {
  export interface Config {}

  export interface Delegates {
    using(using: readonly string[], callback: Plugin.Function<void>): Plugin.Fork
    plugin<T extends Plugin>(plugin: T, config?: boolean | Plugin.Config<T>): Plugin.Fork
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
    // check if it's a valid plugin
    if (typeof plugin !== 'function' && !isApplicable(plugin)) {
      throw new Error('invalid plugin, expect function or object with an "apply" method')
    }

    // validate plugin config
    config = Registry.validate(plugin, config)
    if (!config) return

    // check duplication
    const context = this.caller
    const duplicate = this.get(plugin)
    if (duplicate) {
      if (!duplicate.forkers.length) {
        this.app.emit('logger/warn', 'app', `duplicate plugin detected: ${plugin.name}`)
      }
      return duplicate.fork(context, config)
    }

    const runtime = new Plugin.Runtime(this, plugin, config)
    return runtime.fork(context, config)
  }

  dispose(plugin: Plugin) {
    return this.get(plugin)?.dispose()
  }
}
