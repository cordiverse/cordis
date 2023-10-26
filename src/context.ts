import { defineProperty, isNullable } from 'cosmokit'
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

  export type Internal = Internal.Service | Internal.Mixin

  export namespace Internal {
    export interface Service {
      type: 'service'
      key: symbol
      builtin?: boolean
      prototype?: {}
    }

    export interface Mixin {
      type: 'mixin'
      service: string
    }
  }
}

export interface Context<T = any> {
  [Context.config]: Context.Config
  [Context.shadow]: Record<string | symbol, symbol>
  [Context.internal]: Record<keyof any, Context.Internal>
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
  static mixin(name: string, options: string[] | Context.MixinOptions) {
    const internal = Context.ensureInternal.call(this)
    if (!Array.isArray(options)) {
      options = [...options.accessors || [], ...options.methods || []]
    }
    for (const key of options) {
      internal[key] = { type: 'mixin', service: name }
    }
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
    this.mixin(name, options)
  }

  static handler: ProxyHandler<Context> = {
    get(target, name, ctx: Context) {
      if (typeof name !== 'string') return Reflect.get(target, name, ctx)

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
          if (parent.runtime.inject.has(name)) return
          parent = parent.scope.parent
        }
        ctx.emit('internal/warning', new Error(`property ${name} is not registered, declare it as \`inject\` to suppress this warning`))
      }

      const internal = ctx[Context.internal][name]
      if (!internal) {
        checkInject(name)
        return Reflect.get(target, name, ctx)
      }

      if (internal.type === 'mixin') {
        const service = ctx[internal.service]
        if (isNullable(service)) return service
        const value = Reflect.get(service, name)
        if (typeof value !== 'function') return value
        return value.bind(service)
      } else if (internal.type === 'service') {
        if (!internal.builtin) checkInject(name)
        return ctx.get(name)
      }
    },

    set(target, name, value, ctx: Context) {
      if (typeof name !== 'string') return Reflect.set(target, name, value, ctx)

      const internal = ctx[Context.internal][name]
      if (!internal) return Reflect.set(target, name, value, ctx)
      if (internal.type === 'mixin') {
        return Reflect.set(ctx[internal.service], name, value)
      }

      // service
      const key = ctx[Context.shadow][name] || internal.key
      const oldValue = ctx.root[key]
      if (oldValue === value) return true

      // setup filter for events
      const self = Object.create(null)
      self[Context.filter] = (ctx2: Context) => {
        return ctx[Context.shadow][name] === ctx2[Context.shadow][name]
      }

      // check override
      if (value && oldValue) {
        throw new Error(`service ${name} has been registered`)
      }
      if (isUnproxyable(value)) {
        ctx.emit('internal/warning', new Error(`service ${name} is an unproxyable object, which may lead to unexpected behavior`))
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

  constructor(config?: Context.Config) {
    const self: Context = new Proxy(this, Context.handler)
    config = resolveConfig(getConstructor(this), config)
    self[Context.shadow] = Object.create(null)
    self.root = self
    self.realms = Object.create(null)
    self.mixin('scope', ['config', 'runtime', 'collect', 'accept', 'decline'])
    self.mixin('registry', ['using', 'plugin', 'dispose'])
    self.mixin('lifecycle', ['on', 'once', 'off', 'after', 'parallel', 'emit', 'serial', 'bail', 'start', 'stop'])
    self.provide('registry', new Registry(self, config!), true)
    self.provide('lifecycle', new Lifecycle(self), true)

    const attach = (internal: Context[typeof Context.internal]) => {
      if (!internal) return
      attach(Object.getPrototypeOf(internal))
      for (const key of [...Object.getOwnPropertyNames(internal), ...Object.getOwnPropertySymbols(internal)]) {
        const constructor = internal[key]['prototype']?.constructor
        if (!constructor) continue
        const name = constructor[Context.expose]
        self[key] = new constructor(self, name ? config?.[name] : config)
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
        if (name === Context.current) return this
        return Reflect.get(target, name, receiver)
      },
    })
  }

  provide(name: string, value?: any, builtin?: boolean) {
    const internal = Context.ensureInternal.call(this)
    const key = Symbol(name)
    internal[name] = { type: 'service', key, builtin }
    this[key] = value
  }

  mixin(name: string, mixins: string[]) {
    return Context.mixin.call(this, name, mixins)
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
