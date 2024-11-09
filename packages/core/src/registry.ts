import { defineProperty, Dict } from 'cosmokit'
import { Context } from './context'
import { EffectScope } from './scope'
import { DisposableList, isConstructor, resolveConfig, symbols, withProps } from './utils'

function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
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
            value.call(withProps(this, { [property]: ctx }))
          })
        })
      })
    } else {
      throw new Error('@Inject() can only be used on class or class methods')
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
    Config?: (config: any) => T
    inject?: Inject
    provide?: string | string[]
    intercept?: Dict<boolean>
  }

  export interface Transform<S, T> {
    schema?: true
    Config: (config: S) => T
  }

  export interface Function<C extends Context = Context, T = any> extends Base<T> {
    (ctx: C, config: T): void | Promise<void>
  }

  export interface Constructor<C extends Context = Context, T = any> extends Base<T> {
    new (ctx: C, config: T): any
  }

  export interface Object<C extends Context = Context, T = any> extends Base<T> {
    apply: (ctx: C, config: T) => void | Promise<void>
  }

  export interface Runtime<C extends Context = Context> {
    name?: string
    schema: any
    inject: Dict<Inject.Meta>
    scopes: DisposableList<EffectScope<C>>
    plugin: Plugin
  }

  export function resolve<C extends Context = Context>(plugin: Plugin<C>): Runtime<C> {
    let name = plugin.name
    if (name === 'apply') name = undefined
    const schema = plugin['Config'] || plugin['schema']
    const inject = Inject.resolve(plugin['using'] || plugin['inject'])
    return { name, schema, inject, plugin, scopes: new DisposableList() }
  }
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

class Registry<C extends Context = Context> {
  private _counter = 0
  private _internal = new Map<Function, Plugin.Runtime<C>>()
  protected context: Context

  constructor(public ctx: C) {
    defineProperty(this, symbols.tracker, {
      associate: 'registry',
      property: 'ctx',
    })

    this.context = ctx
  }

  get counter() {
    return ++this._counter
  }

  get size() {
    return this._internal.size
  }

  resolve(plugin: Plugin, assert: true): Function
  resolve(plugin: Plugin, assert?: boolean): Function | undefined
  resolve(plugin: Plugin, assert = false): Function | undefined {
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

  delete(plugin: Plugin) {
    const key = this.resolve(plugin)
    const runtime = key && this._internal.get(key)
    if (!runtime) return
    this._internal.delete(key)
    runtime.scopes.popAll().forEach(scope => scope.dispose())
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

  using(inject: Inject, callback: Plugin.Function<C, void>) {
    return this.inject(inject, callback)
  }

  inject(inject: Inject, callback: Plugin.Function<C, void>) {
    return this.plugin({ inject, apply: callback, name: callback.name })
  }

  plugin(plugin: Plugin<C>, config?: any) {
    // check if it's a valid plugin
    const key = this.resolve(plugin, true)
    this.ctx.scope.assertActive()

    let runtime = this._internal.get(key)
    if (!runtime) {
      runtime = Plugin.resolve<C>(plugin)
      this._internal.set(key!, runtime)
    }

    const outerError = new Error()
    return new EffectScope(this.ctx, config, async (ctx, config) => {
      const innerError = new Error()
      try {
        config = resolveConfig(plugin, config)
        if (typeof plugin !== 'function') {
          await plugin.apply(ctx, config)
        } else if (isConstructor(plugin)) {
          // eslint-disable-next-line new-cap
          const instance = new plugin(ctx, config)
          for (const hook of instance?.[symbols.initHooks] ?? []) {
            hook()
          }
          await instance?.[symbols.setup]?.()
        } else {
          await plugin(ctx, config)
        }
      } catch (error: any) {
        const outerLines = outerError.stack!.split('\n')
        const innerLines = innerError.stack!.split('\n')

        // malformed error
        if (typeof error?.stack !== 'string') {
          outerLines[0] = `Error: ${error}`
          outerError.stack = outerLines.join('\n')
          throw outerError
        }

        // long stack trace
        const lines: string[] = error.stack.split('\n')
        const index = lines.indexOf(innerLines[2])
        if (index === -1) throw error

        lines.splice(index - 1, Infinity)
        // lines.push('    at <cordis>')
        lines.push(...outerLines.slice(3))
        error.stack = lines.join('\n')
        throw error
      }
    }, runtime)
  }
}

export default Registry
