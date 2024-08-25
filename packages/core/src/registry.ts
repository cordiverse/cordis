import { defineProperty, Dict } from 'cosmokit'
import { Context } from './context.ts'
import { ForkScope, MainScope } from './scope.ts'
import { resolveConfig, symbols, withProps } from './utils.ts'

function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

export type Inject = string[] | Dict<Inject.Meta>

export function Inject(inject: Inject) {
  return function (value: any, ctx: ClassDecoratorContext<any> | ClassMethodDecoratorContext<any>) {
    if (ctx.kind === 'class') {
      value.inject = inject
    } else if (ctx.kind === 'method') {
      ctx.addInitializer(function () {
        const property = this[symbols.tracker]?.property
        if (!property) throw new Error('missing context tracker')
        ;(this[property] as Context).inject(inject, (ctx) => {
          value.call(withProps(this, { [property]: ctx }))
        })
      })
    } else {
      throw new Error('@Inject can only be used on class or class methods')
    }
  }
}

export namespace Inject {
  export interface Meta {
    required: boolean
  }

  export function resolve(inject: Inject | null | undefined) {
    if (!inject) return {}
    if (Array.isArray(inject)) {
      return Object.fromEntries(inject.map(name => [name, { required: true }]))
    }
    const { required, optional, ...rest } = inject
    if (Array.isArray(required)) {
      Object.assign(rest, Object.fromEntries(required.map(name => [name, { required: true }])))
    }
    if (Array.isArray(optional)) {
      Object.assign(rest, Object.fromEntries(optional.map(name => [name, { required: false }])))
    }
    return rest
  }
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
    inject?: Inject
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
    using(deps: Inject, callback: Plugin.Function<this, void>): ForkScope<this>
    inject(deps: Inject, callback: Plugin.Function<this, void>): ForkScope<this>
    plugin<T = undefined, S = T>(plugin: Plugin.Function<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): ForkScope<this>
    plugin<T = undefined, S = T>(plugin: Plugin.Constructor<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): ForkScope<this>
    plugin<T = undefined, S = T>(plugin: Plugin.Object<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): ForkScope<this>
    plugin<T = undefined>(plugin: Plugin.Function<this, T>, ...args: Spread<T>): ForkScope<this>
    plugin<T = undefined>(plugin: Plugin.Constructor<this, T>, ...args: Spread<T>): ForkScope<this>
    plugin<T = undefined>(plugin: Plugin.Object<this, T>, ...args: Spread<T>): ForkScope<this>
  }
}

class Registry<C extends Context = Context> {
  private _counter = 0
  private _internal = new Map<Function, MainScope<C>>()
  protected context: Context

  constructor(public ctx: C, config: any) {
    defineProperty(this, symbols.tracker, {
      associate: 'registry',
      property: 'ctx',
    })

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

  using(inject: Inject, callback: Plugin.Function<C, void>) {
    return this.inject(inject, callback)
  }

  inject(inject: Inject, callback: Plugin.Function<C, void>) {
    return this.plugin({ inject, apply: callback, name: callback.name })
  }

  plugin(plugin: Plugin<C>, config?: any, error?: any) {
    // check if it's a valid plugin
    this.resolve(plugin, true)
    this.ctx.scope.assertActive()

    // resolve plugin config
    if (!error) {
      try {
        config = resolveConfig(plugin, config)
      } catch (reason) {
        this.context.emit(this.ctx, 'internal/error', reason)
        error = reason
        config = null
      }
    }

    // check duplication
    let runtime = this.get(plugin)
    if (runtime) {
      if (!runtime.isForkable) {
        this.context.emit(this.ctx, 'internal/warning', new Error(`duplicate plugin detected: ${plugin.name}`))
      }
      return runtime.fork(this.ctx, config, error)
    }

    runtime = new MainScope(this.ctx, plugin, config, error)
    this.set(plugin, runtime)
    return runtime.fork(this.ctx, config, error)
  }
}

export default Registry
