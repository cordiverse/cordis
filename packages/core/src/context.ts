import { defineProperty, Dict, isNullable } from 'cosmokit'
import { Lifecycle } from './events.ts'
import { Registry } from './registry.ts'
import { createTraceable, isUnproxyable, resolveConfig, symbols } from './utils.ts'

export namespace Context {
  export type Parameterized<C, T = any> = C & { config: T }

  /** @deprecated use `string[]` instead */
  export interface MixinOptions {
    methods?: string[]
    accessors?: string[]
    prototype?: {}
  }

  export type Internal = Internal.Service | Internal.Accessor | Internal.Alias

  export namespace Internal {
    export interface Service {
      type: 'service'
      builtin?: boolean
      prototype?: {}
    }

    export interface Accessor {
      type: 'accessor'
      get: () => any
      set?: (value: any) => boolean
    }

    export interface Alias {
      type: 'alias'
      name: string
    }
  }

  export type Associate<P extends string, C extends Context = Context> = {
    [K in keyof C as K extends `${P}.${infer R}` ? R : never]: C[K]
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface Intercept<C extends Context = Context> {}

export interface Context {
  [Context.isolate]: Dict<symbol>
  [Context.intercept]: Intercept<this>
  [Context.internal]: Dict<Context.Internal>
  root: this
  lifecycle: Lifecycle
  registry: Registry<this>
  config: any
}

export class Context {
  static readonly origin: unique symbol = symbols.origin as any
  static readonly events: unique symbol = symbols.events as any
  static readonly static: unique symbol = symbols.static as any
  static readonly filter: unique symbol = symbols.filter as any
  static readonly expose: unique symbol = symbols.expose as any
  static readonly isolate: unique symbol = symbols.isolate as any
  static readonly internal: unique symbol = symbols.internal as any
  static readonly intercept: unique symbol = symbols.intercept as any
  /** @deprecated use `Context.origin` instead */
  static readonly current: typeof Context.origin = Context.origin

  static is<C extends Context>(value: any): value is C {
    return !!value?.[Context.is as any]
  }

  static {
    Context.is[Symbol.toPrimitive] = () => Symbol.for('cordis.is')
    Context.prototype[Context.is as any] = true
  }

  private static ensureInternal(): Context[typeof symbols.internal] {
    const ctx = this.prototype || this
    if (Object.prototype.hasOwnProperty.call(ctx, symbols.internal)) {
      return ctx[symbols.internal]
    }
    const parent = Context.ensureInternal.call(Object.getPrototypeOf(this))
    return ctx[symbols.internal] = Object.create(parent)
  }

  static resolveInject(ctx: Context, name: string) {
    let internal = ctx[symbols.internal][name]
    while (internal?.type === 'alias') {
      name = internal.name
      internal = ctx[symbols.internal][name]
    }
    return [name, internal] as const
  }

  static handler: ProxyHandler<Context> = {
    get(target, prop, ctx: Context) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, ctx)

      const checkInject = (name: string) => {
        // Case 1: a normal property defined on context
        if (Reflect.has(target, name)) return
        // Case 2: built-in services and special properties
        // - prototype: prototype detection
        // - then: async function return
        if (['prototype', 'then', 'registry', 'lifecycle'].includes(name)) return
        // Case 3: `$` or `_` prefix
        if (name[0] === '$' || name[0] === '_') return
        // Case 4: access directly from root
        if (!ctx.runtime.plugin) return
        // Case 5: inject in ancestor contexts
        let parent = ctx
        while (parent.runtime.plugin) {
          for (const key of parent.runtime.inject) {
            if (name === Context.resolveInject(parent, key)[0]) return
          }
          parent = parent.scope.parent
        }
        ctx.emit('internal/warning', new Error(`property ${name} is not registered, declare it as \`inject\` to suppress this warning`))
      }

      const [name, internal] = Context.resolveInject(ctx, prop)
      if (!internal) {
        checkInject(name)
        return Reflect.get(target, name, ctx)
      } else if (internal.type === 'accessor') {
        return internal.get.call(ctx)
      } else {
        if (!internal.builtin) checkInject(name)
        return ctx.get(name)
      }
    },

    set(target, prop, value, ctx: Context) {
      if (typeof prop !== 'string') return Reflect.set(target, prop, value, ctx)

      const [name, internal] = Context.resolveInject(ctx, prop)
      if (!internal) return Reflect.set(target, name, value, ctx)
      if (internal.type === 'accessor') {
        if (!internal.set) return false
        return internal.set.call(ctx, value)
      } else {
        ctx.emit('internal/warning', new Error(`Assigning to service ${name} is not recommended, please use \`ctx.set()\` method instead`))
        ctx.set(name, value)
        return true
      }
    },
  }

  static associate<T extends {}>(object: T, name: string) {
    return new Proxy(object, {
      get(target, key, receiver) {
        if (typeof key === 'symbol' || key in target) return Reflect.get(target, key, receiver)
        const caller: Context = receiver[symbols.origin]
        if (!caller?.[symbols.internal][`${name}.${key}`]) return Reflect.get(target, key, receiver)
        return caller.get(`${name}.${key}`)
      },
      set(target, key, value, receiver) {
        if (typeof key === 'symbol' || key in target) return Reflect.set(target, key, value, receiver)
        const caller: Context = receiver[symbols.origin]
        if (!caller?.[symbols.internal][`${name}.${key}`]) return Reflect.set(target, key, value, receiver)
        caller[`${name}.${key}`] = value
        return true
      },
    })
  }

  constructor(config?: any) {
    const self: Context = new Proxy(this, Context.handler)
    config = resolveConfig(this.constructor, config)
    self[symbols.isolate] = Object.create(null)
    self[symbols.intercept] = Object.create(null)
    self.root = self
    self.mixin('scope', ['config', 'runtime', 'effect', 'collect', 'accept', 'decline'])
    self.mixin('registry', ['using', 'inject', 'plugin', 'dispose'])
    self.mixin('lifecycle', ['on', 'once', 'off', 'after', 'parallel', 'emit', 'serial', 'bail', 'start', 'stop'])
    self.provide('registry', new Registry(self, config!), true)
    self.provide('lifecycle', new Lifecycle(self), true)

    const attach = (internal: Context[typeof symbols.internal]) => {
      if (!internal) return
      attach(Object.getPrototypeOf(internal))
      for (const key of Object.getOwnPropertyNames(internal)) {
        const constructor = internal[key]['prototype']?.constructor
        if (!constructor) continue
        self[internal[key]['key']] = new constructor(self, config)
        defineProperty(self[internal[key]['key']], symbols.origin, self)
      }
    }
    attach(this[symbols.internal])
    return self
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Context <${this.name}>`
  }

  get name() {
    let runtime = this.runtime
    while (runtime && !runtime.name) {
      runtime = runtime.parent.runtime
    }
    return runtime?.name!
  }

  get events() {
    return this.lifecycle
  }

  /** @deprecated */
  get state() {
    return this.scope
  }

  get<K extends string & keyof this>(name: K): undefined | this[K]
  get(name: string): any
  get(name: string) {
    const internal = this[symbols.internal][name]
    if (internal?.type !== 'service') return
    const value = this.root[this[symbols.isolate][name]]
    if (!value || typeof value !== 'object' && typeof value !== 'function') return value
    if (isUnproxyable(value)) {
      defineProperty(value, symbols.origin, this)
      return value
    }
    return createTraceable(this, value)
  }

  set(name: string, value: any) {
    this.provide(name)
    const key = this[symbols.isolate][name]
    const oldValue = this.root[key]
    value ??= undefined
    if (oldValue === value) return

    // check override
    if (!isNullable(value) && !isNullable(oldValue)) {
      throw new Error(`service ${name} has been registered`)
    }
    const ctx: Context = this
    if (!isNullable(value)) {
      ctx.on('dispose', () => ctx.set(name, undefined))
    }
    if (isUnproxyable(value)) {
      ctx.emit('internal/warning', new Error(`service ${name} is an unproxyable object, which may lead to unexpected behavior`))
    }

    // setup filter for events
    const self = Object.create(null)
    self[symbols.filter] = (ctx2: Context) => {
      return ctx[symbols.isolate][name] === ctx2[symbols.isolate][name]
    }

    ctx.emit(self, 'internal/before-service', name, value)
    ctx.root[key] = value
    if (value instanceof Object) {
      defineProperty(value, symbols.origin, ctx)
    }
    ctx.emit(self, 'internal/service', name, oldValue)
  }

  provide(name: string, value?: any, builtin?: boolean) {
    const internal = Context.ensureInternal.call(this.root)
    if (name in internal) return
    const key = Symbol(name)
    internal[name] = { type: 'service', builtin }
    this.root[key] = value
    this.root[Context.isolate][name] = key
  }

  accessor(name: string, options: Omit<Context.Internal.Accessor, 'type'>) {
    const internal = Context.ensureInternal.call(this.root)
    internal[name] ||= { type: 'accessor', ...options }
  }

  alias(name: string, aliases: string[]) {
    const internal = Context.ensureInternal.call(this.root)
    for (const key of aliases) {
      internal[key] ||= { type: 'alias', name }
    }
  }

  mixin(name: string, mixins: string[]) {
    for (const key of mixins) {
      this.accessor(key, {
        get() {
          const service = this[name]
          if (isNullable(service)) return service
          const value = Reflect.get(service, key)
          if (typeof value !== 'function') return value
          return value.bind(service)
        },
        set(value) {
          return Reflect.set(this[name], key, value)
        },
      })
    }
  }

  extend(meta = {}): this {
    return Object.assign(Object.create(this), meta)
  }

  isolate(name: string, label?: symbol) {
    const shadow = Object.create(this[symbols.isolate])
    shadow[name] = label ?? Symbol(name)
    return this.extend({ [symbols.isolate]: shadow })
  }

  intercept<K extends keyof Intercept>(name: K, config: Intercept[K]) {
    const intercept = Object.create(this[symbols.intercept])
    intercept[name] = config
    return this.extend({ [symbols.intercept]: intercept })
  }
}

Context.prototype[Context.internal] = Object.create(null)
