import { defineProperty, Dict } from 'cosmokit'
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
    intercept?: Dict<boolean>
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
  private _internal = new Map<Function, MainScope<C>>()
  protected context: Context

  constructor(public ctx: C, config: any) {
    defineProperty(this, Context.origin, ctx)
    this.context = ctx
    const runtime = new MainScope(ctx, null!, config)
    ctx.scope = runtime
    runtime.ctx = ctx
    this.set(null!, runtime)
  }

  get counter() {
    return ++this._counter
  }

  get size() {
    return this._internal.size
  }

  resolve(plugin: Plugin, assert = false): Function | undefined {
    // Allow `null` as a special case.
    if (plugin === null) return plugin
    if (typeof plugin === 'function') return plugin
    if (isApplicable(plugin)) return plugin.apply
    if (assert) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
  }

  get(plugin: Plugin) {
    const key = this.resolve(plugin)
    return key && this._internal.get(key)
  }

  has(plugin: Plugin) {
    const key = this.resolve(plugin)
    return !!key && this._internal.has(key)
  }

  set(plugin: Plugin, state: MainScope<C>) {
    const key = this.resolve(plugin)
    this._internal.set(key!, state)
  }

  delete(plugin: Plugin) {
    const key = this.resolve(plugin)
    const runtime = key && this._internal.get(key)
    if (!runtime) return
    this._internal.delete(key)
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

  forEach(callback: (value: MainScope<C>, key: Function, map: Map<Plugin, MainScope<C>>) => void) {
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
    this.resolve(plugin, true)

    // magic: this.ctx[symbols.trace] === this
    // Here we ignore the reference
    const ctx: C = Object.getPrototypeOf(this.ctx)
    ctx.scope.assertActive()

    // resolve plugin config
    let error: any
    try {
      config = resolveConfig(plugin, config)
    } catch (reason) {
      this.context.emit(ctx, 'internal/error', reason)
      error = reason
      config = null
    }

    // check duplication
    let runtime = this.get(plugin)
    if (runtime) {
      if (!runtime.isForkable) {
        this.context.emit(ctx, 'internal/warning', new Error(`duplicate plugin detected: ${plugin.name}`))
      }
      return runtime.fork(ctx, config, error)
    }

    runtime = new MainScope(ctx, plugin, config, error)
    this.set(plugin, runtime)
    return runtime.fork(ctx, config, error)
  }
}
