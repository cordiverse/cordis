import { defineProperty, Dict, isNullable } from 'cosmokit'
import { Context } from './context'
import { getTraceable, isObject, isUnproxyable, symbols, withProps } from './utils'

declare module './context' {
  interface Context {
    get<K extends string & keyof this>(name: K): undefined | this[K]
    get(name: string): any
    set<K extends string & keyof this>(name: K, value: undefined | this[K]): () => void
    set(name: string, value: any): () => void
    /** @deprecated use `ctx.set()` instead */
    provide(name: string, value?: any, builtin?: boolean): void
    accessor(name: string, options: Omit<Context.Internal.Accessor, 'type'>): void
    alias(name: string, aliases: string[]): void
    mixin<K extends string & keyof this>(name: K, mixins: (keyof this & keyof this[K])[] | Dict<string>): void
    mixin<T extends {}>(source: T, mixins: (keyof this & keyof T)[] | Dict<string>): void
  }
}

class ReflectService {
  static resolveInject(ctx: Context, name: string) {
    let internal = ctx[symbols.internal][name]
    while (internal?.type === 'alias') {
      name = internal.name
      internal = ctx[symbols.internal][name]
    }
    return [name, internal] as const
  }

  static checkInject(ctx: Context, name: string, error: Error) {
    ctx = ctx[symbols.shadow] ?? ctx
    // Case 1: built-in services and special properties
    // - prototype: prototype detection
    // - then: async function return
    if (['prototype', 'then', 'registry', 'lifecycle'].includes(name)) return
    // Case 2: `$` or `_` prefix
    if (name[0] === '$' || name[0] === '_') return
    // Case 3: access directly from root
    if (!ctx.runtime.plugin) return
    // Case 4: custom inject checks
    if (ctx.bail(ctx, 'internal/inject', name)) return
    const lines = error.stack!.split('\n')
    lines.splice(1, 1)
    error.stack = lines.join('\n')
    ctx.emit(ctx, 'internal/warning', error)
  }

  static handler: ProxyHandler<Context> = {
    get: (target, prop, ctx: Context) => {
      if (typeof prop !== 'string') return Reflect.get(target, prop, ctx)

      if (Reflect.has(target, prop)) {
        return getTraceable(ctx, Reflect.get(target, prop, ctx), true)
      }

      const [name, internal] = ReflectService.resolveInject(target, prop)
      // trace caller
      const error = new Error(`property ${name} is not registered, declare it as \`inject\` to suppress this warning`)
      if (!internal) {
        ReflectService.checkInject(ctx, name, error)
        return Reflect.get(target, name, ctx)
      } else if (internal.type === 'accessor') {
        return internal.get.call(ctx, ctx[symbols.receiver])
      } else {
        if (!internal.builtin) ReflectService.checkInject(ctx, name, error)
        return ctx.reflect.get(name)
      }
    },

    set: (target, prop, value, ctx: Context) => {
      if (typeof prop !== 'string') return Reflect.set(target, prop, value, ctx)

      const [name, internal] = ReflectService.resolveInject(target, prop)
      if (!internal) {
        // TODO warning
        return Reflect.set(target, name, value, ctx)
      }
      if (internal.type === 'accessor') {
        if (!internal.set) return false
        return internal.set.call(ctx, value, ctx[symbols.receiver])
      } else {
        // ctx.emit(ctx, 'internal/warning', new Error(`assigning to service ${name} is not recommended, please use \`ctx.set()\` method instead`))
        ctx.reflect.set(name, value)
        return true
      }
    },

    has: (target, prop) => {
      if (typeof prop !== 'string') return Reflect.has(target, prop)
      if (Reflect.has(target, prop)) return true
      const [, internal] = ReflectService.resolveInject(target, prop)
      return !!internal
    },
  }

  constructor(public ctx: Context) {
    defineProperty(this, symbols.tracker, {
      associate: 'reflect',
      property: 'ctx',
    })

    this._mixin('reflect', ['get', 'set', 'provide', 'accessor', 'mixin', 'alias'])
    this._mixin('scope', ['config', 'runtime', 'effect', 'collect', 'accept', 'decline'])
    this._mixin('registry', ['using', 'inject', 'plugin'])
    this._mixin('lifecycle', ['on', 'once', 'parallel', 'emit', 'serial', 'bail', 'start', 'stop'])
  }

  get(name: string) {
    const internal = this.ctx[symbols.internal][name]
    if (internal?.type !== 'service') return
    const key = this.ctx[symbols.isolate][name]
    const value = this.ctx[symbols.store][key]?.value
    return getTraceable(this.ctx, value)
  }

  set(name: string, value: any) {
    this.provide(name)
    const key = this.ctx[symbols.isolate][name]
    const oldValue = this.ctx[symbols.store][key]?.value
    value ??= undefined
    let dispose = () => {}
    if (oldValue === value) return dispose

    // check override
    if (!isNullable(value) && !isNullable(oldValue)) {
      throw new Error(`service ${name} has been registered`)
    }
    const ctx: Context = this.ctx
    if (!isNullable(value)) {
      dispose = ctx.effect(() => () => {
        ctx.set(name, undefined)
      })
    }
    if (isUnproxyable(value)) {
      ctx.emit(ctx, 'internal/warning', new Error(`service ${name} is an unproxyable object, which may lead to unexpected behavior`))
    }

    // setup filter for events
    const self = Object.create(ctx)
    self[symbols.filter] = (ctx2: Context) => {
      return ctx[symbols.isolate][name] === ctx2[symbols.isolate][name]
    }

    ctx.emit(self, 'internal/before-service', name, value)
    ctx[symbols.store][key] = { value, source: ctx }
    ctx.emit(self, 'internal/service', name, oldValue)
    return dispose
  }

  provide(name: string, value?: any, builtin?: boolean) {
    const internal = this.ctx.root[symbols.internal]
    if (name in internal) return
    const key = Symbol(name)
    internal[name] = { type: 'service', builtin }
    this.ctx.root[symbols.isolate][name] = key
    if (!isObject(value)) return
    this.ctx[symbols.store][key] = { value, source: null! }
    defineProperty(value, symbols.tracker, {
      associate: name,
      property: 'ctx',
    })
  }

  _accessor(name: string, options: Omit<Context.Internal.Accessor, 'type'>) {
    const internal = this.ctx.root[symbols.internal]
    if (name in internal) return () => {}
    internal[name] = { type: 'accessor', ...options }
    return () => delete this.ctx.root[symbols.isolate][name]
  }

  accessor(name: string, options: Omit<Context.Internal.Accessor, 'type'>) {
    this.ctx.scope.effect(() => {
      return this._accessor(name, options)
    })
  }

  alias(name: string, aliases: string[]) {
    const internal = this.ctx.root[symbols.internal]
    if (name in internal) return
    for (const key of aliases) {
      internal[key] ||= { type: 'alias', name }
    }
  }

  _mixin(source: any, mixins: string[] | Dict<string>) {
    const entries = Array.isArray(mixins) ? mixins.map(key => [key, key]) : Object.entries(mixins)
    const getTarget = typeof source === 'string' ? (ctx: Context) => ctx[source] : () => source
    const disposables = entries.map(([key, value]) => {
      return this._accessor(value, {
        get(receiver) {
          const service = getTarget(this)
          if (isNullable(service)) return service
          const mixin = receiver ? withProps(receiver, service) : service
          const value = Reflect.get(service, key, mixin)
          if (typeof value !== 'function') return value
          return value.bind(mixin ?? service)
        },
        set(value, receiver) {
          const service = getTarget(this)
          const mixin = receiver ? withProps(receiver, service) : service
          return Reflect.set(service, key, value, mixin)
        },
      })
    })
    return () => disposables.forEach(dispose => dispose())
  }

  mixin(source: any, mixins: string[] | Dict<string>) {
    this.ctx.scope.effect(() => {
      return this._mixin(source, mixins)
    })
  }

  trace<T>(value: T) {
    return getTraceable(this.ctx, value)
  }

  bind<T extends Function>(callback: T) {
    return new Proxy(callback, {
      apply: (target, thisArg, args) => {
        return target.apply(this.trace(thisArg), args.map(arg => this.trace(arg)))
      },
    })
  }
}

export default ReflectService
