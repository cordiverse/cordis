import { defineProperty } from 'cosmokit'
import { Context } from './context'
import { ForkScope, Inject, MainScope } from './scope'
import { resolveConfig } from './utils'

export function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

export type Plugin<C extends Context = Context, T = any> =
  | Plugin.Function<C, T>
  | Plugin.Constructor<C, T>
  | Plugin.Object<C, T>

export namespace Plugin {
  export interface Base {
    name?: string
    reactive?: boolean
    reusable?: boolean
    Config?: (config?: any) => any
    inject?: string[] | Partial<Inject>
    /** @deprecated use `inject` instead */
    using?: string[] | Partial<Inject>
  }

  export interface Function<C extends Context = Context, T = any> extends Base {
    (ctx: C, options: T): void
  }

  export interface Constructor<C extends Context = Context, T = any> extends Base {
    new (ctx: C, options: T): void
  }

  export interface Object<C extends Context = Context, T = any> extends Base {
    apply: (ctx: C, options: T) => void
  }
}

declare module './context' {
  export interface Context {
    /* eslint-disable max-len */
    using(deps: string[] | Partial<Inject>, callback: Plugin.Function<Context.Parameterized<this, void>, void>): ForkScope<Context.Parameterized<this, void>>
    plugin<T, S = T>(plugin: Plugin.Function<Context.Parameterized<this, T>, T> & { schema?: true; Config: (config?: S) => T }, config?: S): ForkScope<Context.Parameterized<this, T>>
    plugin<T, S = T>(plugin: Plugin.Constructor<Context.Parameterized<this, T>, T> & { schema?: true; Config: (config?: S) => T }, config?: S): ForkScope<Context.Parameterized<this, T>>
    plugin<T, S = T>(plugin: Plugin.Object<Context.Parameterized<this, T>, T> & { schema?: true; Config: (config?: S) => T }, config?: S): ForkScope<Context.Parameterized<this, T>>
    plugin<T>(plugin: Plugin.Function<Context.Parameterized<this, T>, T>, config?: T): ForkScope<Context.Parameterized<this, T>>
    plugin<T>(plugin: Plugin.Constructor<Context.Parameterized<this, T>, T>, config?: T): ForkScope<Context.Parameterized<this, T>>
    plugin<T>(plugin: Plugin.Object<Context.Parameterized<this, T>, T>, config?: T): ForkScope<Context.Parameterized<this, T>>
    /** @deprecated use `ctx.registry.delete()` instead */
    dispose(plugin?: Plugin<Context.Parameterized<this>>): boolean
    /* eslint-enable max-len */
  }
}

export namespace Registry {
  export interface Config {}
}

export class Registry<C extends Context = Context> {
  private _counter = 0
  private _internal = new Map<Plugin<C>, MainScope<C>>()

  constructor(private root: Context, config: Registry.Config) {
    defineProperty(this, Context.current, root)
    root.scope = new MainScope(this, null!, config)
    root.scope.runtime.isReactive = true
  }

  get counter() {
    return ++this._counter
  }

  get size() {
    return this._internal.size
  }

  resolve(plugin: Plugin) {
    // Allow `null` as a special case.
    if (plugin === null) return plugin
    if (typeof plugin === 'function') return plugin
    if (isApplicable(plugin)) return plugin.apply
    throw new Error('invalid plugin, expect function or object with an "apply" method')
  }

  get(plugin: Plugin<C>) {
    return this._internal.get(this.resolve(plugin))
  }

  has(plugin: Plugin<C>) {
    return this._internal.has(this.resolve(plugin))
  }

  set(plugin: Plugin<C>, state: MainScope<C>) {
    return this._internal.set(this.resolve(plugin), state)
  }

  delete(plugin: Plugin<C>) {
    plugin = this.resolve(plugin)
    const runtime = this.get(plugin)
    if (!runtime) return false
    this._internal.delete(plugin)
    return runtime.dispose()
  }

  keys() {
    return this._internal.keys()
  }

  values() {
    return this._internal.values()
  }

  entries() {
    return this._internal.entries()
  }

  forEach(callback: (value: MainScope<C>, key: Plugin<C>, map: Map<Plugin<C>, MainScope<C>>) => void) {
    return this._internal.forEach(callback)
  }

  using(inject: string[] | Partial<Inject>, callback: Plugin.Function<C, void>) {
    return this.plugin({ inject, apply: callback, name: callback.name })
  }

  plugin(plugin: Plugin<C>, config?: any) {
    // check if it's a valid plugin
    this.resolve(plugin)
    const context: Context = this[Context.current]

    if (context.scope.uid === null) {
      context.emit('internal/warning' , new Error("try to plugin on a disposed scope"))
      return
    }

    // resolve plugin config
    let error: any
    try {
      config = resolveConfig(plugin, config)
    } catch (reason) {
      context.emit('internal/warning', reason)
      error = reason
      config = null
    }

    // check duplication
    let runtime = this.get(plugin)
    if (runtime) {
      if (!runtime.isForkable) {
        context.emit('internal/warning', new Error(`duplicate plugin detected: ${plugin.name}`))
      }
      return runtime.fork(context, config, error)
    }

    runtime = new MainScope(this, plugin, config, error)
    return runtime.fork(context, config, error)
  }

  dispose(plugin: Plugin<C>) {
    return this.delete(plugin)
  }
}
