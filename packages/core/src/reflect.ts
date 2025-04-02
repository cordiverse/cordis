import { defineProperty, Dict, isNullable } from 'cosmokit'
import { Context } from './context'
import { getTraceable, isUnproxyable, symbols, withProps } from './utils'
import { FiberState } from './fiber'

declare module './context' {
  interface Context {
    get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]
    get(name: string, strict?: boolean): any
    set<K extends string & keyof this>(name: K, value: undefined | this[K]): () => void
    set(name: string, value: any): () => void
    /** @deprecated use `ctx.set()` instead */
    provide(name: string): void
    accessor(name: string, options: Omit<Context.Internal.Accessor, 'type'>): void
    mixin<K extends string & keyof this>(name: K, mixins: (keyof this & keyof this[K])[] | Dict<string>): void
    mixin<T extends {}>(source: T, mixins: (keyof this & keyof T)[] | Dict<string>): void
  }
}

const RESERVED_WORDS = ['prototype', 'then']

function enhanceError(error: Error, message: string) {
  const lines = error.stack!.split('\n')
  error.message = message
  lines.splice(0, 2, `Error: ${message}`)
  error.stack = lines.join('\n')
  return error
}

export class ReflectService {
  static checkInject(ctx: Context, name: string, error: Error, key?: symbol) {
    ctx = ctx[symbols.shadow] ?? ctx
    // Case 1: access directly from root
    if (!ctx.fiber.runtime) return
    // Case 2: custom inject checks
    let message = `cannot get property "${name}" without inject`
    if (key) {
      const result = ctx.bail(ctx, 'internal/inject', name, key)
      if (result === true) return
      if (typeof result === 'string') {
        message = result
      }
    }
    throw enhanceError(error, message)
  }

  static handler: ProxyHandler<Context> = {
    get: (target, prop, ctx: Context) => {
      if (typeof prop !== 'string' || RESERVED_WORDS.includes(prop)) {
        return Reflect.get(target, prop, ctx)
      }
      if (Reflect.has(target, prop)) {
        return getTraceable(ctx, Reflect.get(target, prop, ctx))
      }

      // trace caller
      const error = new Error()
      const internal = target[symbols.internal][prop]
      if (!internal) {
        throw enhanceError(error, `cannot get property "${prop}" without inject`)
      } else if (internal.type === 'accessor') {
        return internal.get.call(ctx, ctx[symbols.receiver], error)
      } else {
        const cached = ctx.fiber.store?.[prop]
        if (cached) return getTraceable(ctx, cached)
        const key = target[symbols.isolate][prop]
        ReflectService.checkInject(ctx, prop, error, key)
        return ctx.reflect.get(prop)
      }
    },

    set: (target, prop, value, ctx: Context) => {
      if (typeof prop !== 'string' || RESERVED_WORDS.includes(prop)) {
        return Reflect.set(target, prop, value, ctx)
      }

      const internal = target[symbols.internal][prop]
      // trace caller
      const error = new Error(`set service ${prop} without \`provide\``)
      if (!internal) {
        // TODO warning
        return Reflect.set(target, prop, value, ctx)
      }
      if (internal.type === 'accessor') {
        if (!internal.set) return false
        return internal.set.call(ctx, value, ctx[symbols.receiver], error)
      } else {
        // ctx.emit(ctx, 'internal/warn', new Error(`assigning to service ${name} is not recommended, please use \`ctx.set()\` method instead`))
        ctx.reflect.set(prop, value)
        return true
      }
    },

    has: (target, prop) => {
      if (typeof prop !== 'string' || RESERVED_WORDS.includes(prop)) {
        return Reflect.has(target, prop)
      }
      if (Reflect.has(target, prop)) return true
      return !!target[symbols.internal][prop]
    },
  }

  constructor(public ctx: Context) {
    defineProperty(this, symbols.tracker, {
      associate: 'reflect',
      property: 'ctx',
      noShadow: true,
    })

    this._mixin('reflect', ['get', 'set', 'provide', 'accessor', 'mixin', 'alias'], true)
    this._mixin('fiber', ['runtime', 'effect'], true)
    this._mixin('registry', ['inject', 'plugin'], true)
    this._mixin('events', ['on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall'], true)
  }

  // FIXME active should default to true
  get(name: string, active = false, traceable = true) {
    const internal = this.ctx[symbols.internal][name]
    if (internal?.type !== 'service') return
    const key = this.ctx[symbols.isolate][name]
    const item = this.ctx[symbols.store][key]
    if (!item) return
    if (active && item.source.fiber.state !== FiberState.ACTIVE) return
    if (traceable) return getTraceable(this.ctx, item.value)
    return item.value
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
      dispose = ctx.fiber.effect(() => () => {
        this.set(name, undefined)
      }, `ctx.set(${JSON.stringify(name)})`)
    }
    if (isUnproxyable(value)) {
      ctx.emit(ctx, 'internal/warn', new Error(`service ${name} is an unproxyable object, which may lead to unexpected behavior`))
    }

    // setup filter for events
    const self = Object.create(ctx)
    self[symbols.filter] = (ctx2: Context) => {
      return ctx[symbols.isolate][name] === ctx2[symbols.isolate][name]
    }

    ctx.emit(self, 'internal/before-service', name, value)
    ctx[symbols.store][key] = { name, value, source: self }
    if (ctx.fiber.state === FiberState.ACTIVE) {
      ctx.emit(self, 'internal/service', name, oldValue)
    }
    return dispose
  }

  provide(name: string) {
    const internal = this.ctx.root[symbols.internal]
    if (name in internal) return
    const key = Symbol(name)
    internal[name] = { type: 'service' }
    this.ctx.root[symbols.isolate][name] = key
  }

  _accessor(name: string, options: Omit<Context.Internal.Accessor, 'type'>) {
    const internal = this.ctx.root[symbols.internal]
    if (name in internal) return () => {}
    internal[name] = { type: 'accessor', ...options }
    return () => delete internal[name]
  }

  accessor(name: string, options: Omit<Context.Internal.Accessor, 'type'>) {
    this.ctx.fiber.effect(() => {
      return this._accessor(name, options)
    }, `ctx.accessor(${JSON.stringify(name)})`)
  }

  _mixin(source: string, mixins: string[] | Dict<string>, strict = false) {
    const entries = Array.isArray(mixins) ? mixins.map(key => [key, key]) : Object.entries(mixins)
    const getTarget = (ctx: Context, error: Error) => {
      // TODO enhance error message
      return ctx[source]
    }
    const disposables = entries.map(([key, value]) => {
      return this._accessor(value, {
        get(receiver, error) {
          const service = getTarget(this, error)
          if (isNullable(service)) return service
          const mixin = receiver ? withProps(receiver, service) : service
          const value = Reflect.get(service, key, mixin)
          if (typeof value !== 'function') return value
          return value.bind(mixin ?? service)
        },
        set(value, receiver, error) {
          const service = getTarget(this, error)
          const mixin = receiver ? withProps(receiver, service) : service
          return Reflect.set(service, key, value, mixin)
        },
      })
    })
    return () => disposables.forEach(dispose => dispose())
  }

  mixin(source: any, mixins: string[] | Dict<string>) {
    this.ctx.fiber.effect(() => {
      return this._mixin(source, mixins)
    }, `ctx.mixin(${JSON.stringify(source)})`)
  }

  trace<T>(value: T) {
    return getTraceable(this.ctx, value)
  }

  bind<T extends Function>(callback: T) {
    return new Proxy(callback, {
      apply: (target, thisArg, args) => {
        return Reflect.apply(target, this.trace(thisArg), args.map(arg => this.trace(arg)))
      },
      construct: (target, args, newTarget) => {
        return Reflect.construct(target, args.map(arg => this.trace(arg)), newTarget)
      },
    })
  }
}
