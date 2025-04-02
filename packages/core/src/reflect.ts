import { defineProperty, Dict, isNullable } from 'cosmokit'
import { Context } from './context'
import { getTraceable, isUnproxyable, symbols, withProps } from './utils'
import { Fiber, FiberState } from './fiber'

declare module './context' {
  interface Context {
    get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]
    get(name: string, strict?: boolean): any
    set<K extends string & keyof this>(name: K, value: undefined | this[K]): () => void
    set(name: string, value: any): () => void
    /** @deprecated use `ctx.set()` instead */
    provide(name: string): void
    accessor(name: string, options: Omit<Property.Accessor, 'type'>): void
    mixin<K extends string & keyof this>(name: K, mixins: (keyof this & keyof this[K])[] | Dict<string>): void
    mixin<T extends {}>(source: T, mixins: (keyof this & keyof T)[] | Dict<string>): void
  }
}

function enhanceError(error: Error) {
  const lines = error.stack!.split('\n')
  lines.splice(0, 2, `Error: ${error.message}`)
  error.stack = lines.join('\n')
  return error
}

const RESERVED_WORDS = ['prototype', 'then']

// - is a symbol
// - is a reserved word (prototype, then)
// - is a number string (0, 1, 2, ...)
function isSpecialProperty(prop: string | symbol): prop is symbol {
  return typeof prop === 'symbol' || RESERVED_WORDS.includes(prop) || parseInt(prop).toString() === prop
}

export type Property = Property.Service | Property.Accessor

export namespace Property {
  export interface Service {
    type: 'service'
  }

  export interface Accessor {
    type: 'accessor'
    get: (this: Context, receiver: any, error: Error) => any
    set?: (this: Context, value: any, receiver: any, error: Error) => boolean
  }
}

export interface Impl<C extends Context = Context> {
  name: string
  value?: any
  fiber: Fiber<C>
}

export class ReflectService<C extends Context = Context> {
  static handler: ProxyHandler<Context> = {
    get: (target, prop, ctx: Context) => {
      if (isSpecialProperty(prop)) {
        return Reflect.get(target, prop, ctx)
      }
      if (Reflect.has(target, prop)) {
        return getTraceable(ctx, Reflect.get(target, prop, ctx))
      }

      const error = new Error(`cannot get property "${prop}" without inject`)
      const internal = target.reflect.props[prop]
      if (!internal) throw enhanceError(error)

      try {
        if (internal.type === 'accessor') {
          return internal.get.call(ctx, ctx[symbols.receiver], error)
        }

        return ctx.events.waterfall('internal/get', ctx, prop, error, () => {
          const key = target[symbols.isolate][prop]
          const provider = ctx.reflect.store[key]?.fiber
          let fiber = (ctx[symbols.shadow] as Context ?? ctx).fiber
          while (true) {
            if (fiber === provider) return ctx.reflect.get(prop, false)
            const inject = fiber.inject[prop]
            if (inject) {
              if (!inject.required) return ctx.reflect.get(prop, true)
              if (fiber.store) return getTraceable(ctx, fiber.store[prop])
              error.message = `cannot get required service "${prop}" in inactive context`
              throw error
            }
            if (!fiber.runtime) throw error
            if (fiber.parent[symbols.isolate][prop] !== key) throw error
            fiber = fiber.parent.fiber
          }
        })
      } catch (e: any) {
        throw e === error ? enhanceError(e) : e
      }
    },

    set: (target, prop, value, ctx: Context) => {
      if (isSpecialProperty(prop)) {
        return Reflect.set(target, prop, value, ctx)
      }

      const error = new Error(`cannot set property "${prop}" without provide`)
      const internal = target.reflect.props[prop]
      if (!internal) throw enhanceError(error)

      try {
        if (internal.type === 'accessor') {
          if (!internal.set) return false
          return internal.set.call(ctx, value, ctx[symbols.receiver], error)
        }

        ctx.reflect.set(prop, value)
        return true
      } catch (e: any) {
        throw e === error ? enhanceError(e) : e
      }
    },

    has: (target, prop) => {
      if (isSpecialProperty(prop)) {
        return Reflect.has(target, prop)
      }
      if (Reflect.has(target, prop)) return true
      return !!target.reflect.props[prop]
    },
  }

  public store: Dict<Impl<C>, symbol> = Object.create(null)
  public props: Dict<Property> = Object.create(null)

  constructor(public ctx: C) {
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })

    this._mixin('reflect', ['get', 'set', 'provide', 'accessor', 'mixin'], true)
    this._mixin('fiber', ['runtime', 'effect'], true)
    this._mixin('registry', ['inject', 'plugin'], true)
    this._mixin('events', ['on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall'], true)
  }

  get(name: string, strict = true) {
    const internal = this.props[name]
    if (internal?.type !== 'service') return
    const key = this.ctx[symbols.isolate][name]
    const impl = this.store[key]
    if (!impl) return
    if (strict && impl.fiber.state !== FiberState.ACTIVE) return
    return getTraceable(this.ctx, impl.value)
  }

  set(name: string, value: any) {
    this.provide(name)
    const key = this.ctx[symbols.isolate][name]
    const oldValue = this.store[key]?.value
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
      ctx.events.emit(ctx, 'internal/warn', new Error(`service ${name} is an unproxyable object, which may lead to unexpected behavior`))
    }

    // setup filter for events
    const self = Object.create(ctx)
    self[symbols.filter] = (ctx2: Context) => {
      return ctx[symbols.isolate][name] === ctx2[symbols.isolate][name]
    }

    ctx.events.emit(self, 'internal/before-service', name, value)
    ctx.reflect.store[key] = { name, value, fiber: ctx.fiber }
    if (ctx.fiber.state === FiberState.ACTIVE) {
      ctx.events.emit(self, 'internal/service', name, oldValue)
    }
    return dispose
  }

  provide(name: string) {
    if (!this.props[name]) {
      this.props[name] ??= { type: 'service' }
    } else if (this.props[name].type !== 'service') {
      throw new Error(`propery "${name}" is already declared as ${this.props[name].type}`)
    }
    const key = this.ctx.root[symbols.isolate][name] ??= Symbol(name)
    this.store[key] ??= { name, value: undefined, fiber: this.ctx.fiber }
  }

  _accessor(name: string, options: Omit<Property.Accessor, 'type'>) {
    if (name in this.props) return () => {}
    this.props[name] = { type: 'accessor', ...options }
    return () => delete this.props[name]
  }

  accessor(name: string, options: Omit<Property.Accessor, 'type'>) {
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
