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
  // `replace()` leaves the old plugin forwarding to its replacement: calling
  // `plugin(old)` afterwards creates a fiber of `next`, while `keys()`,
  // `values()` and `size` keep reporting only the implementations in use
  private _forward = new Map<Function, Plugin>()

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

  // Follows `_forward` to the implementation currently in use. `source` is the
  // plugin object that carries the metadata of that implementation.
  private _forwarded(plugin: Plugin, key: Function) {
    if (!this._forward.size) return { key, source: plugin }
    const seen = new Set<Function>()
    let source = plugin
    while (!seen.has(key)) {
      seen.add(key)
      const next = this._forward.get(key)
      if (!next) break
      const resolved = this.resolve(next)
      if (!resolved) break
      source = next
      key = resolved
    }
    return { key, source }
  }

  get(plugin: Plugin) {
    const resolved = this.resolve(plugin)
    return resolved && this._internal.get(this._forwarded(plugin, resolved).key)
  }

  has(plugin: Plugin) {
    const resolved = this.resolve(plugin)
    return !!resolved && this._internal.has(this._forwarded(plugin, resolved).key)
  }

  delete(plugin: Plugin) {
    const resolved = this.resolve(plugin)
    const key = resolved && this._forwarded(plugin, resolved).key
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

  forEach(callback: (value: Plugin.Runtime, key: Function) => void) {
    return this._internal.forEach(callback)
  }

  inject(inject: Inject, callback: Plugin.Function<void>) {
    return this.plugin({ inject, apply: callback, name: callback.name })
  }

  plugin(plugin: Plugin, config?: any, getOuterStack = buildOuterStack()) {
    // check if it's a valid plugin
    const resolved = this.resolve(plugin)
    if (!resolved) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
    // a replaced plugin forwards to its replacement, so the fiber is created
    // against the runtime and the metadata of the implementation in use
    const { key: callback, source } = this._forwarded(plugin, resolved)
    this.ctx.fiber.assertActive()

    let runtime = this._internal.get(callback)
    if (!runtime) {
      let name = source.name
      if (name === 'apply') name = undefined
      runtime = { name, callback, fibers: new DisposableList(), Config: source.Config }
      this._internal.set(callback, runtime)
    }

    const fiber = new Fiber(this.ctx, config, Inject.resolve(source.inject), runtime, getOuterStack)
    const wrapped = Object.create(fiber) as Fiber & PromiseLike<Fiber>
    wrapped.then = (onFulfilled, onRejected) => {
      return fiber.await().then(onFulfilled, onRejected)
    }
    return wrapped
  }

  // Swaps the implementation behind the fibers of `plugin` for `next`: the
  // fibers keep their identity, so code holding one stays valid, and plugins no
  // loader entry manages can be replaced too. A replaced fiber restarts, which
  // withdraws and reinstalls its provisions, so its dependents reload with it.
  // Failures to rebuild are returned keyed by fiber instead of swallowed.
  async replace(plugin: Plugin, next: Plugin): Promise<Map<Fiber, Error>> {
    const resolved = this.resolve(plugin)
    const runtime = resolved && this._internal.get(this._forwarded(plugin, resolved).key)
    if (!runtime) return new Map()
    const resolvedNext = this.resolve(next)
    if (!resolvedNext) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof next)
    // `next` may be a replaced plugin as well; the implementation in use wins
    const { key: nextKey, source } = this._forwarded(next, resolvedNext)
    if (nextKey === runtime.callback) return new Map()

    let target = this._internal.get(nextKey)
    const created = !target
    if (!target) {
      let name = source.name
      if (name === 'apply') name = undefined
      target = { name, callback: nextKey, fibers: new DisposableList(), Config: source.Config }
      this._internal.set(nextKey, target)
    }

    // the old key stops being an implementation of its own and forwards instead
    const previous = runtime.callback
    this._internal.delete(previous)
    for (const key of [...this._forward.keys()]) {
      if (this._forwarded(source, key).key === previous) this._forward.set(key, source)
    }
    this._forward.set(previous, source)

    const fibers = [...runtime.fibers]
    const restarts: [Fiber, Promise<void>][] = []
    const failures = new Map<Fiber, Error>()
    // move every fiber first so a synchronous failure cannot stop the others,
    // then wait for the restarts together
    for (const fiber of fibers) {
      try {
        const restart = fiber._replace(target, Inject.resolve(source.inject))
        if (restart) restarts.push([fiber, restart])
      } catch (error) {
        failures.set(fiber, error as Error)
      }
    }
    // nothing moved into a runtime this call created: do not leave it behind
    if (created && !target.fibers.length) this._internal.delete(nextKey)
    await Promise.all(restarts.map(async ([fiber, restart]) => {
      try {
        await restart
      } catch (error) {
        failures.set(fiber, error as Error)
      }
    }))
    return failures
  }
}
