import { defineProperty } from 'cosmokit'
import { Context } from './context.ts'
import { ForkScope, MainScope } from './scope.ts'
import { resolveConfig } from './utils.ts'

export function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

export interface Inject {
  readonly required?: string[]
  readonly optional?: string[]
}

export type Plugin<C extends Context = Context, T = any> =
  | Plugin.Function<C, T>
  | Plugin.Constructor<C, T>
  | Plugin.Object<C, T>

export namespace Plugin {
  export interface Base<T = any> {
    name?: string
    reactive?: boolean
    reusable?: boolean
    Config?: (config: any) => T
    inject?: string[] | Inject
  }

  export interface Transform<S, T> {
    schema?: true
    Config: (config: S) => T
  }

  export interface Function<C extends Context = Context, T = any> extends Base<T> {
    (ctx: C, config: T): void
  }

  export interface Constructor<C extends Context = Context, T = any> extends Base<T> {
    new (ctx: C, config: T): void
  }

  export interface Object<C extends Context = Context, T = any> extends Base<T> {
    apply: (ctx: C, config: T) => void
  }
}

export type Spread<T> = undefined extends T ? [config?: T] : [config: T]

declare module './context.ts' {
  export interface Context {
    /** @deprecated use `ctx.inject()` instead */
    using(deps: string[] | Inject, callback: Plugin.Function<this, void>): ForkScope<this>
    inject(deps: string[] | Inject, callback: Plugin.Function<this, void>): ForkScope<this>
    plugin<T = undefined, S = T>(plugin: Plugin.Function<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): ForkScope<this>
    plugin<T = undefined, S = T>(plugin: Plugin.Constructor<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): ForkScope<this>
    plugin<T = undefined, S = T>(plugin: Plugin.Object<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): ForkScope<this>
    plugin<T = undefined>(plugin: Plugin.Function<this, T>, ...args: Spread<T>): ForkScope<this>
    plugin<T = undefined>(plugin: Plugin.Constructor<this, T>, ...args: Spread<T>): ForkScope<this>
    plugin<T = undefined>(plugin: Plugin.Object<this, T>, ...args: Spread<T>): ForkScope<this>
  }
}

export class Registry<C extends Context = Context> {
  private _counter = 0
  private _internal = new Map<Plugin, MainScope<C>>()

  constructor(private root: Context, config: any) {
    defineProperty(this, Context.origin, root)
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
    throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
  }

  get(plugin: Plugin) {
    return this._internal.get(this.resolve(plugin))
  }

  has(plugin: Plugin) {
    return this._internal.has(this.resolve(plugin))
  }

  set(plugin: Plugin, state: MainScope<C>) {
    const oldValue = this._internal.get(this.resolve(plugin))
    this._internal.set(this.resolve(plugin), state)
    return oldValue
  }

  delete(plugin: Plugin) {
    plugin = this.resolve(plugin)
    const runtime = this.get(plugin)
    if (!runtime) return
    this._internal.delete(plugin)
    runtime.dispose()
    return runtime
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

  forEach(callback: (value: MainScope<C>, key: Plugin, map: Map<Plugin, MainScope<C>>) => void) {
    return this._internal.forEach(callback)
  }

  using(inject: string[] | Inject, callback: Plugin.Function<C, void>) {
    return this.inject(inject, callback)
  }

  inject(inject: string[] | Inject, callback: Plugin.Function<C, void>) {
    return this.plugin({ inject, apply: callback, name: callback.name })
  }

  plugin(plugin: Plugin<C>, config?: any) {
    // check if it's a valid plugin
    this.resolve(plugin)

    const context: Context = this[Context.origin]
    context.scope.assertActive()

    // resolve plugin config
    let error: any
    try {
      config = resolveConfig(plugin, config)
    } catch (reason) {
      context.emit('internal/error', reason)
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
}
