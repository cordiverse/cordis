import { defineProperty, Dict, isNullable } from 'cosmokit'
import { Lifecycle } from './events'
import { Registry } from './registry'
import { getConstructor, isConstructor, isUnproxyable, resolveConfig } from './utils'

export namespace Context {
  export type Parameterized<C, T = any> = Omit<C, 'config'> & { config: T }

  export interface Config extends Lifecycle.Config, Registry.Config {}

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
      key: symbol
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
    readonly [K in keyof C as K extends `${P}.${infer R}` ? R : never]: C[K]
  }
}

export interface Context<T = any> {
  [Context.config]: Context.Config
  [Context.shadow]: Dict<symbol>
  [Context.internal]: Dict<Context.Internal>
  root: Context.Parameterized<this, this[typeof Context.config]>
  realms: Record<string, Record<string, symbol>>
  lifecycle: Lifecycle
  registry: Registry<this>
  config: T
}

export class Context {
  static readonly config = Symbol.for('cordis.config')
  static readonly events = Symbol.for('cordis.events')
  static readonly static = Symbol.for('cordis.static')
  static readonly filter = Symbol.for('cordis.filter')
  static readonly source = Symbol.for('cordis.source')
  static readonly expose = Symbol.for('cordis.expose')
  static readonly shadow = Symbol.for('cordis.shadow')
  static readonly current = Symbol.for('cordis.current')
  static readonly internal = Symbol.for('cordis.internal')

  private static ensureInternal(): Context[typeof Context.internal] {
    const ctx = this.prototype || this
    if (Object.prototype.hasOwnProperty.call(ctx, Context.internal)) {
      return ctx[Context.internal]
    }
    const parent = Context.ensureInternal.call(Object.getPrototypeOf(this))
    return ctx[Context.internal] = Object.create(parent)
  }

  /** @deprecated */
  static service(name: string, options: string[] | Context.MixinOptions = {}) {
    const internal = this.ensureInternal()
    if (name in internal) return
    const key = typeof name === 'symbol' ? name : Symbol(name)
    internal[name] = { type: 'service', key }
    if (isConstructor(options)) {
      internal[name]['prototype'] = options.prototype
    }
  }

  static resolveInject(ctx: Context, name: string) {
    let internal = ctx[Context.internal][name]
    while (internal?.type === 'alias') {
      name = internal.name
      internal = ctx[Context.internal][name]
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
        // Case 3: access directly from root
        if (!ctx.runtime.plugin) return
        // Case 4: inject in ancestor contexts
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
      }

      if (internal.type === 'accessor') {
        return internal.get.call(ctx)
      } else if (internal.type === 'service') {
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
      }

      // service
      const key = ctx[Context.shadow][name] || internal.key
      const oldValue = ctx.root[key]
      if (oldValue === value) return true

      // check override
      if (value && oldValue) {
        throw new Error(`service ${name} has been registered`)
      }
      ctx.on('dispose', () => ctx[name] = undefined)
      if (isUnproxyable(value)) {
        ctx.emit('internal/warning', new Error(`service ${name} is an unproxyable object, which may lead to unexpected behavior`))
      }

      // setup filter for events
      const self = Object.create(null)
      self[Context.filter] = (ctx2: Context) => {
        // TypeScript is not smart enough to infer the type of `name` here
        return ctx[Context.shadow][name as string] === ctx2[Context.shadow][name as string]
      }

      ctx.root.emit(self, 'internal/before-service', name, value)
      ctx.root[key] = value
      if (value && typeof value === 'object') {
        defineProperty(value, Context.source, ctx)
      }
      ctx.root.emit(self, 'internal/service', name, oldValue)
      return true
    },
  }

  static associate<T extends {}>(object: T, name: string) {
    return new Proxy(object, {
      get(target, key, receiver) {
        if (typeof key === 'symbol' || key in target) return Reflect.get(target, key, receiver)
        const caller: Context = receiver[Context.current]
        if (!caller?.[Context.internal][`${name}.${key}`]) return Reflect.get(target, key, receiver)
        return caller.get(`${name}.${key}`)
      },
      set(target, key, value, receiver) {
        if (typeof key === 'symbol' || key in target) return Reflect.set(target, key, value, receiver)
        const caller: Context = receiver[Context.current]
        if (!caller?.[Context.internal][`${name}.${key}`]) return Reflect.set(target, key, value, receiver)
        caller[`${name}.${key}`] = value
        return true
      },
    })
  }

  constructor(config?: Context.Config) {
    const self: Context = new Proxy(this, Context.handler)
    config = resolveConfig(getConstructor(this), config)
    self[Context.shadow] = Object.create(null)
    self.root = self
    self.realms = Object.create(null)
    self.mixin('scope', ['config', 'runtime', 'collect', 'accept', 'decline'])
    self.mixin('registry', ['using', 'inject', 'plugin', 'dispose'])
    self.mixin('lifecycle', ['on', 'once', 'off', 'after', 'parallel', 'emit', 'serial', 'bail', 'start', 'stop'])
    self.provide('registry', new Registry(self, config!), true)
    self.provide('lifecycle', new Lifecycle(self), true)

    const attach = (internal: Context[typeof Context.internal]) => {
      if (!internal) return
      attach(Object.getPrototypeOf(internal))
      for (const key of Object.getOwnPropertyNames(internal)) {
        const constructor = internal[key]['prototype']?.constructor
        if (!constructor) continue
        self[internal[key]['key']] = new constructor(self, config)
        self[internal[key]['key']][Context.source] = self
      }
    }
    attach(this[Context.internal])
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
    return runtime?.name
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
    const internal = this[Context.internal][name]
    if (internal?.type !== 'service') return
    const key: symbol = this[Context.shadow][name] || internal.key
    const value = this.root[key]
    if (!value || typeof value !== 'object') return value
    if (isUnproxyable(value)) {
      defineProperty(value, Context.current, this)
      return value
    }
    return new Proxy(value, {
      get: (target, name, receiver) => {
        if (name === Context.current || name === 'caller') return this
        return Reflect.get(target, name, receiver)
      },
    })
  }

  provide(name: string, value?: any, builtin?: boolean) {
    const internal = Context.ensureInternal.call(this.root)
    const key = Symbol(name)
    internal[name] = { type: 'service', key, builtin }
    this.root[key] = value
  }

  accessor(name: string, options: Omit<Context.Internal.Accessor, 'type'>) {
    const internal = Context.ensureInternal.call(this.root)
    internal[name] = { type: 'accessor', ...options }
  }

  alias(name: string, aliases: string[]) {
    const internal = Context.ensureInternal.call(this.root)
    for (const key of aliases) {
      internal[key] = { type: 'alias', name }
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

  isolate(names: string[], label?: string) {
    const self = this.extend()
    self[Context.shadow] = Object.create(this[Context.shadow])
    for (const name of names) {
      self[Context.shadow][name] = label ? ((this.realms[label] ??= Object.create(null))[name] ??= Symbol(name)) : Symbol(name)
    }
    return self
  }
}

Context.prototype[Context.internal] = Object.create(null)
