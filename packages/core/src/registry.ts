import { defineProperty, Dict } from 'cosmokit'
import { StandardSchemaV1 } from '@standard-schema/spec'
import { Context } from './context.ts'
import { Fiber } from './fiber.ts'
import { buildOuterStack, DisposableList, symbols, withProps } from './utils.ts'

function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

export type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }

export type InjectKey = keyof {
  [K in keyof Context & string as Context[K] extends { [symbols.metadata]: any } ? K : never]: any
}

export function Inject<K extends InjectKey>(name: K, config?: Context[K] extends { [symbols.metadata]: infer T } ? T : never) {
  return function (value: any, decorator: ClassDecoratorContext<any> | ClassMethodDecoratorContext<any>) {
    if (decorator.kind === 'class') {
      if (!Object.hasOwn(value, 'inject')) {
        defineProperty(value, 'inject', Object.create(Object.getPrototypeOf(value).inject ?? null))
        defineProperty(value.inject, symbols.checkProto, true)
      }
      value.inject[name] = config
    } else if (decorator.kind === 'method') {
      const inject = (value[symbols.decorator] ??= {}).inject ??= Object.create(null)
      inject[name] = config
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
  export function resolve(inject: Inject | null | undefined, result: Dict = Object.create(null)) {
    if (!inject) return result
    if (Array.isArray(inject)) {
      for (const name of inject) {
        result[name] = null
      }
    } else if (Reflect.has(inject, symbols.checkProto)) {
      Object.assign(result, resolve(Object.getPrototypeOf(inject)))
      for (const name of Object.keys(inject)) {
        result[name] = inject[name] ?? null
      }
    } else {
      for (const name of Object.keys(inject)) {
        result[name] = inject[name] ?? null
      }
    }
    return result
  }
}

export type Plugin<T = any> =
  | Plugin.Function<T>
  | Plugin.Constructor<T>
  | Plugin.Object<T>

export namespace Plugin {
  export interface Base<T = any> {
    name?: string
    Config?: StandardSchemaV1<any, T>
    inject?: Inject
    provide?: string | string[]
    intercept?: Dict<boolean>
  }

  export interface Transform<S, T> {
    schema?: true
    Config: (config: S) => T
  }

  export interface Function<T = any> extends Base<T> {
    (ctx: Context, config: T): any
  }

  export interface Constructor<T = any> extends Base<T> {
    new (ctx: Context, config: T): any
  }

  export interface Object<T = any> extends Base<T> {
    apply(ctx: Context, config: T): any
  }

  export interface Runtime {
    name?: string
    fibers: DisposableList<Fiber>
    callback: globalThis.Function
    Config?: StandardSchemaV1
  }
}

type Spread<T> = undefined extends T ? [config?: T] : [config: T]

type GetPluginParameters<P> =
  | P extends (ctx: Context, ...args: infer R) => any
  ? R
  : P extends new (ctx: Context, ...args: infer R) => any
  ? R
  : P extends { apply(ctx: Context, ...args: infer R): any }
  ? R
  : never

type GetPluginConfig<P> =
  | P extends Plugin.Transform<infer S, any>
  ? S
  : GetPluginParameters<P>[0]

declare module './context.ts' {
  export interface Context {
    inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>
    plugin<P extends Plugin>(plugin: P, ...args: Spread<GetPluginConfig<P>>): Fiber & PromiseLike<Fiber>
  }
}

export class RegistryService {
  private _counter = 0
  private _internal = new Map<Function, Plugin.Runtime>()
  private _aliases = new WeakMap<Function, Plugin>()

  constructor(public ctx: Context) {
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })
  }

  get counter() {
    return ++this._counter
  }

  get size() {
    return this._internal.size
  }

  resolve(plugin: Plugin): Function | undefined {
    // plugin.apply may throw
    try {
      if (typeof plugin === 'function') return plugin
      if (isApplicable(plugin)) return plugin.apply
    } catch {}
  }

  private _forward(plugin: Plugin): [key: Function, plugin: Plugin] | undefined {
    let key = this.resolve(plugin)
    while (key) {
      const next = this._aliases.get(key)
      if (!next) return [key, plugin]
      plugin = next
      key = this.resolve(next)
    }
  }

  private _create(callback: Function, plugin: Plugin) {
    let name = plugin.name
    if (name === 'apply') name = undefined
    const runtime: Plugin.Runtime = { name, callback, fibers: new DisposableList(), Config: plugin.Config }
    this._internal.set(callback, runtime)
    return runtime
  }

  get(plugin: Plugin) {
    const key = this._forward(plugin)?.[0]
    return key && this._internal.get(key)
  }

  has(plugin: Plugin) {
    const key = this._forward(plugin)?.[0]
    return !!key && this._internal.has(key)
  }

  delete(plugin: Plugin) {
    const key = this._forward(plugin)?.[0]
    const runtime = key && this._internal.get(key)
    if (!runtime) return
    this._internal.delete(key)
    for (const fiber of [...runtime.fibers]) {
      fiber.dispose()
    }
    return runtime
  }

  replace(oldPlugin: Plugin, newPlugin: Plugin): Fiber[] {
    const source = this._forward(oldPlugin)
    if (!source) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof oldPlugin)
    const key = this.resolve(newPlugin)
    if (!key) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof newPlugin)

    // `next` is an implementation of its own again
    this._aliases.delete(key)
    const [oldKey] = source
    const runtime = this._internal.get(oldKey)
    let target = this._internal.get(key)
    if (oldKey !== key) {
      this._internal.delete(oldKey)
      this._aliases.set(oldKey, newPlugin)
    }

    const fibers = runtime ? [...runtime.fibers] : []
    if (!fibers.length) return fibers
    target ??= this._create(key, newPlugin)

    for (const fiber of fibers) {
      fiber._replace(target, Inject.resolve(newPlugin.inject))
    }
    return fibers
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

  forEach(callback: (value: Plugin.Runtime, key: Function) => void) {
    return this._internal.forEach(callback)
  }

  inject(inject: Inject, callback: Plugin.Function<void>) {
    return this.plugin({ inject, apply: callback, name: callback.name })
  }

  plugin(plugin: Plugin, config?: any, getOuterStack = buildOuterStack()) {
    // check if it's a valid plugin
    const forwarded = this._forward(plugin)
    if (!forwarded) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
    this.ctx.fiber.assertActive()

    const [callback, target] = forwarded
    const runtime = this._internal.get(callback) ?? this._create(callback, target)
    const fiber = new Fiber(this.ctx, config, Inject.resolve(target.inject), runtime, getOuterStack)
    const wrapped = Object.create(fiber) as Fiber & PromiseLike<Fiber>
    wrapped.then = (onFulfilled, onRejected) => {
      return fiber.await().then(onFulfilled, onRejected)
    }
    return wrapped
  }
}
