import { Context } from './context'
import { Fork, Runtime } from './state'

function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

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
}

export namespace Registry {
  export interface Config {}

  export interface Delegates {
    using(using: readonly string[], callback: Plugin.Function<void>): Fork
    plugin<T extends Plugin>(plugin: T, config?: boolean | Plugin.Config<T>): Fork
    dispose(plugin?: Plugin): Runtime
  }
}

export class Registry extends Map<Plugin, Runtime> {
  constructor(public app: Context, private config: Registry.Config) {
    super()
    this[Context.current] = app
    app.state = new Runtime(this, null, config)
  }

  private resolve(plugin: Plugin) {
    return plugin && (typeof plugin === 'function' ? plugin : plugin.apply)
  }

  get(plugin: Plugin) {
    return super.get(this.resolve(plugin))
  }

  has(plugin: Plugin) {
    return super.has(this.resolve(plugin))
  }

  set(plugin: Plugin, state: Runtime) {
    return super.set(this.resolve(plugin), state)
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
    // check if it's a valid plugin
    if (typeof plugin !== 'function' && !isApplicable(plugin)) {
      throw new Error('invalid plugin, expect function or object with an "apply" method')
    }

    // validate plugin config
    config = Registry.validate(plugin, config)
    if (!config) return

    // check duplication
    const context = this[Context.current]
    const duplicate = this.get(plugin)
    if (duplicate) {
      if (!duplicate.isForkable) {
        this.app.emit('internal/warning', `duplicate plugin detected: ${plugin.name}`)
      }
      return duplicate.fork(context, config)
    }

    const runtime = new Runtime(this, plugin, config)
    return runtime.fork(context, config)
  }

  dispose(plugin: Plugin) {
    const runtime = this.get(plugin)
    if (!runtime) return
    runtime.dispose()
    return runtime
  }
}
