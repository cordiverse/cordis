import { defineProperty } from 'cosmokit'
import { Context } from './context'
import { Fork, Runtime } from './state'
import { resolveConfig } from './utils'

export function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

export type Plugin<C extends Context = Context> =
  | Plugin.Function<any, C>
  | Plugin.Constructor<any, C>
  | Plugin.Object<any, any, C>

export namespace Plugin {
  export type Function<T = any, C extends Context = any> = (ctx: C, options: T) => void
  export type Constructor<T = any, C extends Context = any> = new (ctx: C, options: T) => void

  export interface Object<S = any, T = any, C extends Context = any> {
    name?: string
    apply: Function<T, C>
    reactive?: boolean
    reusable?: boolean
    Config?: (config?: S) => T
    schema?: (config?: S) => T
    using?: readonly string[]
  }

  export type Config<T extends Plugin<any>> =
    | T extends Constructor<infer U> ? U
    : T extends Function<infer U> ? U
    : T extends Object<infer U> ? U
    : never
}

declare module './context' {
  export interface Context {
    using(using: readonly string[], callback: Plugin.Function<void, Context.Parameterized<this>>): Fork<Context.Parameterized<this>>
    plugin<S extends Plugin<Context.Parameterized<this>>, T extends Plugin.Config<S>>(plugin: S, config?: boolean | T): Fork<Context.Parameterized<this, T>>
    /** @deprecated use `ctx.registry.delete()` instead */
    dispose(plugin?: Plugin<Context.Parameterized<this>>): boolean
  }
}

export namespace Registry {
  export interface Config {}
}

export class Registry<C extends Context = Context> extends Map<Plugin<C>, Runtime<C>> {
  static readonly methods = ['using', 'plugin', 'dispose']

  private _counter = 0

  constructor(private root: Context, config: Registry.Config) {
    super()
    defineProperty(this, Context.current, root)
    root.state = new Runtime(this, null!, config)
    root.state.runtime.isReactive = true
  }

  get counter() {
    return ++this._counter
  }

  private resolve(plugin: Plugin) {
    return plugin && (typeof plugin === 'function' ? plugin : plugin.apply)
  }

  get(plugin: Plugin<C>) {
    return super.get(this.resolve(plugin))
  }

  has(plugin: Plugin<C>) {
    return super.has(this.resolve(plugin))
  }

  set(plugin: Plugin<C>, state: Runtime<C>) {
    return super.set(this.resolve(plugin), state)
  }

  delete(plugin: Plugin<C>) {
    plugin = this.resolve(plugin)
    const runtime = this.get(plugin)
    if (!runtime) return false
    super.delete(plugin)
    return runtime.dispose()
  }

  using(using: readonly string[], callback: Plugin.Function<void, C>) {
    return this.plugin({ using, apply: callback, name: callback.name })
  }

  plugin(plugin: Plugin<C>, config?: any) {
    // check if it's a valid plugin
    if (typeof plugin !== 'function' && !isApplicable(plugin)) {
      throw new Error('invalid plugin, expect function or object with an "apply" method')
    }

    // resolve plugin config
    config = resolveConfig(plugin, config)
    if (!config) return

    // check duplication
    const context = this[Context.current]
    let runtime = this.get(plugin)
    if (runtime) {
      if (!runtime.isForkable) {
        this.root.emit('internal/warning', `duplicate plugin detected: ${plugin.name}`)
      }
      return runtime.fork(context, config)
    }

    runtime = new Runtime(this, plugin, config)
    return runtime.fork(context, config)
  }

  dispose(plugin: Plugin<C>) {
    return this.delete(plugin)
  }
}
