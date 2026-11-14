import { defineProperty, Dict } from 'cosmokit'
import { StandardSchemaV1 } from '@standard-schema/spec'
import { Context } from './context.ts'
import { Fiber } from './fiber.ts'
import { buildOuterStack, DisposableList, symbols, withProps } from './utils.ts'

function isApplicable(object: Component) {
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
            if (!property) return value.call(this)
            // `Object.prototype` members would shadow the service; the bag replaces
            // only the tracker's `ctx`, so it must not inherit from `Object`.
            const bag = Object.create(null)
            bag[property] = ctx
            return value.call(withProps(this, bag))
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

export type Component<T = any> =
  | Component.Function<T>
  | Component.Constructor<T>
  | Component.Object<T>

export namespace Component {
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

type GetComponentParameters<P> =
  | P extends (ctx: Context, ...args: infer R) => any
  ? R
  : P extends new (ctx: Context, ...args: infer R) => any
  ? R
  : P extends { apply(ctx: Context, ...args: infer R): any }
  ? R
  : never

type GetComponentConfig<P> =
  | P extends Component.Transform<infer S, any>
  ? S
  : GetComponentParameters<P>[0]

declare module './context.ts' {
  export interface Context {
    inject(deps: Inject, callback: Component.Function<void>): Fiber & PromiseLike<Fiber>
    use<P extends Component>(component: P, ...args: Spread<GetComponentConfig<P>>): Fiber & PromiseLike<Fiber>
    /** @deprecated Use `ctx.use()` instead. */
    plugin<P extends Component>(component: P, ...args: Spread<GetComponentConfig<P>>): Fiber & PromiseLike<Fiber>
  }
}

export class RegistryService {
  private _counter = 0
  private _internal = new Map<Function, Component.Runtime>()
  private _aliases = new WeakMap<Function, Component>()

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

  resolve(component: Component): Function | undefined {
    // component.apply may throw
    try {
      if (typeof component === 'function') return component
      if (isApplicable(component)) return component.apply
    } catch {}
  }

  private _forward(component: Component): [key: Function, component: Component] | undefined {
    let key = this.resolve(component)
    while (key) {
      const next = this._aliases.get(key)
      if (!next) return [key, component]
      component = next
      key = this.resolve(next)
    }
  }

  private _create(callback: Function, component: Component) {
    let name = component.name
    if (name === 'apply') name = undefined
    const runtime: Component.Runtime = { name, callback, fibers: new DisposableList(), Config: component.Config }
    this._internal.set(callback, runtime)
    return runtime
  }

  get(component: Component) {
    const key = this._forward(component)?.[0]
    return key && this._internal.get(key)
  }

  has(component: Component) {
    const key = this._forward(component)?.[0]
    return !!key && this._internal.has(key)
  }

  _unregister(runtime: Component.Runtime) {
    this._internal.delete(runtime.callback)
  }

  replace(oldComponent: Component, newComponent: Component): Fiber[] {
    const source = this._forward(oldComponent)
    if (!source) throw new Error('invalid component, expect function or object with an "apply" method, received ' + typeof oldComponent)
    const key = this.resolve(newComponent)
    if (!key) throw new Error('invalid component, expect function or object with an "apply" method, received ' + typeof newComponent)

    // `next` is an implementation of its own again
    this._aliases.delete(key)
    const [oldKey] = source
    const runtime = this._internal.get(oldKey)
    let target = this._internal.get(key)
    if (oldKey !== key) {
      this._internal.delete(oldKey)
      this._aliases.set(oldKey, newComponent)
    }

    const fibers = runtime ? [...runtime.fibers] : []
    if (!fibers.length) return fibers
    target ??= this._create(key, newComponent)

    for (const fiber of fibers) {
      fiber._replace(target, Inject.resolve(newComponent.inject))
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

  forEach(callback: (value: Component.Runtime, key: Function) => void) {
    return this._internal.forEach(callback)
  }

  inject(inject: Inject, callback: Component.Function<void>) {
    return this.use({ inject, apply: callback, name: callback.name })
  }

  /** @deprecated Use `registry.use()` instead. */
  plugin(component: Component, config?: any, getOuterStack = buildOuterStack()) {
    return this.use(component, config, getOuterStack)
  }

  use(component: Component, config?: any, getOuterStack = buildOuterStack()) {
    // check if it's a valid component
    const forwarded = this._forward(component)
    if (!forwarded) throw new Error('invalid component, expect function or object with an "apply" method, received ' + typeof component)
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
