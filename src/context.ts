import { defineProperty } from 'cosmokit'
import { Lifecycle } from './events'
import { Registry } from './registry'
import { getConstructor, isConstructor, resolveConfig } from './utils'

export namespace Context {
  export type Parameterized<C, T = any> = Omit<C, 'config'> & { config: T }

  export interface Config extends Lifecycle.Config, Registry.Config {}

  export interface MixinOptions {
    methods?: string[]
    accessors?: string[]
    prototype?: any
  }

  export type Internal = Internal.Service | Internal.Accessor | Internal.Method

  export namespace Internal {
    export interface Service {
      type: 'service'
      key: symbol
      prototype?: {}
    }

    export interface Accessor {
      type: 'accessor'
      service: keyof any
    }

    export interface Method {
      type: 'method'
      service: keyof any
    }
  }
}

export interface Context<T = any> {
  [Context.config]: Context.Config
  [Context.internal]: Record<keyof any, Context.Internal>
  root: Context.Parameterized<this, this[typeof Context.config]>
  mapping: Record<string | symbol, symbol>
  realms: Record<string, Record<string, symbol>>
  lifecycle: Lifecycle
  registry: Registry<this>
  config: T
}

export class Context {
  static readonly config = Symbol('config')
  static readonly events = Symbol('events')
  static readonly static = Symbol('static')
  static readonly filter = Symbol('filter')
  static readonly source = Symbol('source')
  static readonly expose = Symbol('expose')
  static readonly current = Symbol('current')
  static readonly internal = Symbol('internal')

  private static ensureInternal(): Context[typeof Context.internal] {
    if (Object.prototype.hasOwnProperty.call(this.prototype, this.internal)) {
      return this.prototype[this.internal]
    }
    const parent = Object.getPrototypeOf(this).ensureInternal()
    return this.prototype[this.internal] = Object.create(parent)
  }

  /** @deprecated */
  static mixin(name: keyof any, options: Context.MixinOptions) {
    const internal = this.ensureInternal()
    for (const key of options.methods || []) {
      internal[key] = { type: 'method', service: name }
    }
    for (const key of options.accessors || []) {
      internal[key] = { type: 'accessor', service: name }
    }
  }

  /** @deprecated */
  static service(name: keyof any, options: Context.MixinOptions = {}) {
    const internal = this.ensureInternal()
    const key = typeof name === 'symbol' ? name : Symbol(name)
    internal[name] = { type: 'service', key }
    if (isConstructor(options)) {
      internal[name]['prototype'] = options.prototype
    }
    this.mixin(name, options)
  }

  static handler: ProxyHandler<Context> = {
    get(target, name, receiver) {
      if (typeof name !== 'string') return Reflect.get(target, name, receiver)
      const internal = receiver[Context.internal][name]
      if (!internal) return Reflect.get(target, name, receiver)
      if (internal.type === 'accessor') {
        return Reflect.get(receiver[internal.service], name)
      } else if (internal.type === 'method') {
        return defineProperty(function (this: Context, ...args: any[]) {
          return this[internal.service][name](...args)
        }, 'name', name)
      } else if (internal.type === 'service') {
        const privateKey = receiver.mapping[name] || internal.key
        const value = receiver.root[privateKey]
        if (!value) return
        defineProperty(value, Context.current, receiver)
        return value
      }
    },
    set(target, name, value, receiver) {
      if (typeof name !== 'string') return Reflect.set(target, name, value, receiver)
      const internal = receiver[Context.internal][name]
      if (!internal) return Reflect.set(target, name, value, receiver)
      if (internal.type === 'accessor') {
        return Reflect.set(receiver[internal.service], name, value)
      } else if (internal.type === 'service') {
        const key = receiver.mapping[name] || internal.key
        const oldValue = receiver.root[key]
        if (oldValue === value) return true

        // setup filter for events
        const self = Object.create(null)
        self[Context.filter] = (ctx: Context) => {
          return receiver.mapping[name] === ctx.mapping[name]
        }

        // check override
        if (value && oldValue && typeof name === 'string') {
          throw new Error(`service ${name} has been registered`)
        }

        if (typeof name === 'string' && !internal.prototype) {
          receiver.root.emit(self, 'internal/before-service', name, value)
        }
        receiver.root[key] = value
        if (value && typeof value === 'object') {
          defineProperty(value, Context.source, receiver)
        }
        if (typeof name === 'string' && !internal.prototype) {
          receiver.root.emit(self, 'internal/service', name, oldValue)
        }
        return true
      }
      return false
    },
  }

  constructor(config?: Context.Config) {
    const self = new Proxy(Object.create(Object.getPrototypeOf(this)), Context.handler)
    config = resolveConfig(getConstructor(this), config)
    self.root = self as any
    self.mapping = Object.create(null)
    self.realms = Object.create(null)

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
    return `Context <${this.runtime.name}>`
  }

  get events() {
    return this.lifecycle
  }

  /** @deprecated */
  get state() {
    return this.scope
  }

  extend(meta = {}): this {
    return Object.assign(Object.create(this), meta)
  }

  isolate(names: string[], label?: string) {
    const mapping = Object.create(this.mapping)
    for (const name of names) {
      mapping[name] = label ? ((this.realms[label] ??= Object.create(null))[name] ??= Symbol(name)) : Symbol(name)
    }
    return this.extend({ mapping })
  }
}

Context.prototype[Context.internal] = Object.create(null)

Context.service('registry', Registry)
Context.service('lifecycle', Lifecycle)

Context.mixin('scope', {
  accessors: ['config', 'runtime'],
  methods: ['collect', 'accept', 'decline'],
})
