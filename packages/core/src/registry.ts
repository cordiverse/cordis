import { defineProperty, Dict } from 'cosmokit'
import { Context } from './context'
import { Fiber } from './fiber'
import { buildOuterStack, DisposableList, symbols, withProps } from './utils'

function isApplicable<C extends Context>(object: Plugin<C>) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

export type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]: boolean | Inject.Meta<M[K]> }

export type InjectKey<C extends Context> = keyof {
  [K in keyof C & string as C[K] extends { [symbols.config]: any } ? K : never]: any
}

export function Inject<K extends InjectKey<Context>>(name: K, required = true, config?: Context[K] extends { [symbols.config]: infer T } ? T : never) {
  return function (value: any, decorator: ClassDecoratorContext<any> | ClassMethodDecoratorContext<any>) {
    if (decorator.kind === 'class') {
      if (!Object.hasOwn(value, 'inject')) {
        defineProperty(value, 'inject', Object.create(Object.getPrototypeOf(value).inject ?? null))
        defineProperty(value.inject, symbols.checkProto, true)
      }
      value.inject[name] = { required, config }
    } else if (decorator.kind === 'method') {
      const inject = (value[symbols.metadata] ??= {}).inject ??= Object.create(null)
      inject[name] = { required, config }
      decorator.addInitializer(function () {
        const property = this[symbols.tracker]?.property
        ;(this[symbols.initHooks] ??= []).push(() => {
          (this.ctx as Context).inject(inject, (ctx) => {
            return value.call(property ? withProps(this, { [property]: ctx }) : this)
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

  export function resolve(inject: Inject | null | undefined, result: Dict<Meta | undefined> = Object.create(null)) {
    if (!inject) return result
    if (Array.isArray(inject)) {
      for (const name of inject) {
        result[name] = { required: true }
      }
    } else if (Reflect.has(inject, symbols.checkProto)) {
      Object.assign(result, resolve(Object.getPrototypeOf(inject)), inject)
    } else {
      for (const [name, value] of Object.entries(inject)) {
        result[name] = typeof value === 'boolean' ? { required: value } : value
      }
    }
    return result
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
    (ctx: C, config: T): any
  }

  export interface Constructor<in C extends Context = Context, T = any> extends Base<T> {
    new (ctx: C, config: T): any
  }

  export interface Object<in C extends Context = Context, T = any> extends Base<T> {
    apply(ctx: C, config: T): any
  }

  export interface Runtime<out C extends Context = Context> {
    name?: string
    fibers: DisposableList<Fiber<C>>
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
    inject(deps: Inject, callback: Plugin.Function<this, void>): Fiber<this> & PromiseLike<Fiber<this>>
    plugin<T = undefined, S = T>(plugin: Plugin.Function<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): Fiber<this> & PromiseLike<Fiber<this>>
    plugin<T = undefined, S = T>(plugin: Plugin.Constructor<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): Fiber<this> & PromiseLike<Fiber<this>>
    plugin<T = undefined, S = T>(plugin: Plugin.Object<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): Fiber<this> & PromiseLike<Fiber<this>>
    plugin<T = undefined>(plugin: Plugin.Function<this, T>, ...args: Spread<T>): Fiber<this> & PromiseLike<Fiber<this>>
    plugin<T = undefined>(plugin: Plugin.Constructor<this, T>, ...args: Spread<T>): Fiber<this> & PromiseLike<Fiber<this>>
    plugin<T = undefined>(plugin: Plugin.Object<this, T>, ...args: Spread<T>): Fiber<this> & PromiseLike<Fiber<this>>
  }
}

export class RegistryService<out C extends Context = Context> {
  private _counter = 0
  private _internal = new Map<Function, Plugin.Runtime<C>>()
  protected context: Context

  constructor(public ctx: C) {
    defineProperty(this, symbols.tracker, {
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
    // plugin.apply may throw
    try {
      if (typeof plugin === 'function') return plugin
      if (isApplicable(plugin)) return plugin.apply
    } catch {}
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
    for (const fiber of runtime.fibers) {
      fiber.dispose()
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

  plugin(plugin: Plugin<C>, config?: any, getOuterStack = buildOuterStack()) {
    // check if it's a valid plugin
    const callback = this.resolve(plugin)
    if (!callback) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
    this.ctx.fiber.assertActive()

    let runtime = this._internal.get(callback)
    if (!runtime) {
      let name = plugin.name
      if (name === 'apply') name = undefined
      runtime = { name, callback, fibers: new DisposableList(), Config: plugin.Config }
      this._internal.set(callback, runtime)
    }

    const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack)
    const wrapped = Object.create(fiber) as Fiber<C> & PromiseLike<Fiber<C>>
    wrapped.then = (onFulfilled, onRejected) => {
      return fiber.await().then(onFulfilled, onRejected)
    }
    return wrapped
  }
}
