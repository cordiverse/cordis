import { defineProperty, Dict } from 'cosmokit'
import { Context } from './context'
import { EffectScope } from './scope'
import { DisposableList, symbols, withProps } from './utils'

function isApplicable<C extends Context>(object: Plugin<C>) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

function buildOuterStack() {
  const outerError = new Error()
  return () => outerError.stack!.split('\n').slice(3)
}

export type Inject = string[] | Dict<Inject.Meta>

export function Inject(inject: Inject) {
  return function (value: any, decorator: ClassDecoratorContext<any> | ClassMethodDecoratorContext<any>) {
    if (decorator.kind === 'class') {
      value.inject = inject
    } else if (decorator.kind === 'method') {
      decorator.addInitializer(function () {
        const property = this[symbols.tracker]?.property
        if (!property) throw new Error('missing context tracker')
        ;(this[symbols.initHooks] ??= []).push(() => {
          (this[property] as Context).inject(inject, (ctx) => {
            return value.call(withProps(this, { [property]: ctx }))
          })
        })
      })
    } else {
      throw new Error('@Inject() can only be used on class or class methods')
    }
  }
}

export namespace Inject {
  export interface Meta<T = any> {
    required: boolean
    config?: T
  }

  export function resolve(inject: Inject | null | undefined) {
    if (!inject) return {}
    if (Array.isArray(inject)) {
      return Object.fromEntries(inject.map(name => [name, { required: true }]))
    }
    return inject
  }
}

export type Plugin<C extends Context = Context, T = any> =
  | Plugin.Function<C, T>
  | Plugin.Constructor<C, T>
  | Plugin.Object<C, T>

export namespace Plugin {
  export interface Base<T = any> {
    name?: string
    Config?: (config: any) => T
    inject?: Inject
    provide?: string | string[]
    intercept?: Dict<boolean>
  }

  export interface Transform<S, T> {
    schema?: true
    Config: (config: S) => T
  }

  export interface Function<in C extends Context = Context, T = any> extends Base<T> {
    (ctx: C, config: T): void | Promise<void>
  }

  export interface Constructor<in C extends Context = Context, T = any> extends Base<T> {
    new (ctx: C, config: T): any
  }

  export interface Object<in C extends Context = Context, T = any> extends Base<T> {
    apply: (ctx: C, config: T) => void | Promise<void>
  }

  export interface Runtime<out C extends Context = Context> {
    name?: string
    scopes: DisposableList<EffectScope<C>>
    callback: globalThis.Function
    Config?: (config: any) => any
  }
}

export function resolveConfig(runtime: Plugin.Runtime, config: any) {
  return runtime.Config ? runtime.Config(config) : config
}

export type Spread<T> = undefined extends T ? [config?: T] : [config: T]

declare module './context' {
  export interface Context {
    inject(deps: Inject, callback: Plugin.Function<this, void>): EffectScope<this>
    plugin<T = undefined, S = T>(plugin: Plugin.Function<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): EffectScope<this>
    plugin<T = undefined, S = T>(plugin: Plugin.Constructor<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): EffectScope<this>
    plugin<T = undefined, S = T>(plugin: Plugin.Object<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): EffectScope<this>
    plugin<T = undefined>(plugin: Plugin.Function<this, T>, ...args: Spread<T>): EffectScope<this>
    plugin<T = undefined>(plugin: Plugin.Constructor<this, T>, ...args: Spread<T>): EffectScope<this>
    plugin<T = undefined>(plugin: Plugin.Object<this, T>, ...args: Spread<T>): EffectScope<this>
  }
}

class Registry<out C extends Context = Context> {
  private _counter = 0
  private _internal = new Map<Function, Plugin.Runtime<C>>()
  protected context: Context

  constructor(public ctx: C) {
    defineProperty(this, symbols.tracker, {
      associate: 'registry',
      property: 'ctx',
      noShadow: true,
    })

    this.context = ctx
  }

  get counter() {
    return ++this._counter
  }

  get size() {
    return this._internal.size
  }

  resolve(plugin: Plugin<C>): Function | undefined {
    if (typeof plugin === 'function') return plugin
    if (isApplicable(plugin)) return plugin.apply
  }

  get(plugin: Plugin<C>) {
    const key = this.resolve(plugin)
    return key && this._internal.get(key)
  }

  has(plugin: Plugin<C>) {
    const key = this.resolve(plugin)
    return !!key && this._internal.has(key)
  }

  delete(plugin: Plugin<C>) {
    const key = this.resolve(plugin)
    const runtime = key && this._internal.get(key)
    if (!runtime) return
    this._internal.delete(key)
    for (const scope of runtime.scopes) {
      scope.dispose()
    }
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

  forEach(callback: (value: Plugin.Runtime<C>, key: Function) => void) {
    return this._internal.forEach(callback)
  }

  inject(inject: Inject, callback: Plugin.Function<C, void>) {
    return this.plugin({ inject, apply: callback, name: callback.name })
  }

  plugin(plugin: Plugin<C>, config?: any, getOuterStack: () => Iterable<string> = buildOuterStack()) {
    // check if it's a valid plugin
    const callback = this.resolve(plugin)
    if (!callback) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
    this.ctx.scope.assertActive()

    let runtime = this._internal.get(callback)
    if (!runtime) {
      let name = plugin.name
      if (name === 'apply') name = undefined
      runtime = { name, callback, scopes: new DisposableList(), Config: plugin.Config }
      this._internal.set(callback, runtime)
    }

    return new EffectScope(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack)
  }
}

export default Registry
