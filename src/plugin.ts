import { defineProperty } from 'cosmokit'
import { Context } from './context'
import { Fork, Runtime } from './state'

function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

export type Plugin<C extends Context = Context> =
  | Plugin.Function<any, C>
  | Plugin.Constructor<any, C>
  | Plugin.Object<any, any, C>

export namespace Plugin {
  export type Function<T = any, C extends Context = Context> = (ctx: C, options: T) => void
  export type Constructor<T = any, C extends Context = Context> = new (ctx: C, options: T) => void

  export interface Object<S = any, T = any, C extends Context = Context> {
    name?: string
    apply: Function<T, C>
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

declare module './context' {
  export interface Context {
    using(using: readonly string[], callback: Plugin.Function<void, this>): Fork
    plugin<T extends Plugin<this>>(plugin: T, config?: boolean | Plugin.Config<T>): Fork
    dispose(plugin?: Plugin<this>): Runtime
  }
}

export namespace Registry {
  export interface Config {}
}

export class Registry<C extends Context = Context> extends Map<Plugin<C>, Runtime> {
  private _counter = 0

  constructor(private app: C, private config: Registry.Config) {
    super()
    defineProperty(this, Context.current, app)
    app.state = new Runtime(this, null, config)
  }

  get counter() {
    return ++this._counter
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
