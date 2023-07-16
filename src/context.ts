import { defineProperty } from 'cosmokit'
import { Lifecycle } from './events'
import { Registry } from './registry'
import { getConstructor, isConstructor, resolveConfig } from './utils'

export interface Context<T = any> {
  [Context.config]: Context.Config
  root: Context.Configured<this, this[typeof Context.config]>
  mapping: Record<string | symbol, symbol>
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

  constructor(config?: Context.Config) {
    const options = resolveConfig(getConstructor(this), config)
    const attach = (internal: {}) => {
      if (!internal) return
      attach(Object.getPrototypeOf(internal))
      for (const key of Object.getOwnPropertySymbols(internal)) {
        const constructor = internal[key]
        const name = constructor[Context.expose]
        this[key] = new constructor(this, name ? options?.[name] : options)
      }
    }

    this.root = this as any
    this.mapping = Object.create(null)
    attach(this[Context.internal])
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

  isolate(names: string[]) {
    const mapping = Object.create(this.mapping)
    for (const name of names) {
      mapping[name] = Symbol(name)
    }
    return this.extend({ mapping })
  }
}

export namespace Context {
  export type Configured<C, T = any> = Omit<C, 'config'> & { config: T }

  export interface Config extends Lifecycle.Config, Registry.Config {}

  export interface MixinOptions {
    methods?: string[]
    properties?: string[]
  }

  export function mixin(name: keyof any, options: MixinOptions) {
    for (const key of options.methods || []) {
      const method = defineProperty(function (this: Context, ...args: any[]) {
        return this[name][key](...args)
      }, 'name', key)
      defineProperty(this.prototype, key, method)
    }

    for (const key of options.properties || []) {
      Object.defineProperty(this.prototype, key, {
        configurable: true,
        get(this: Context) {
          return this[name][key]
        },
        set(this: Context, value: any) {
          this[name][key] = value
        },
      })
    }
  }

  export interface ServiceOptions extends MixinOptions {
    prototype?: any
  }

  export function service(name: keyof any, options: ServiceOptions = {}) {
    if (Object.prototype.hasOwnProperty.call(this.prototype, name)) return
    const privateKey = typeof name === 'symbol' ? name : Symbol(name)

    Object.defineProperty(this.prototype, name, {
      configurable: true,
      get(this: Context) {
        const key = this.mapping[name as any] || privateKey
        const value = this.root[key]
        if (!value) return
        defineProperty(value, Context.current, this)
        return value
      },
      set(this: Context, value) {
        const key = this.mapping[name] || privateKey
        const oldValue = this.root[key]
        if (oldValue === value) return

        // setup filter for events
        const self = Object.create(null)
        self[Context.filter] = (ctx: Context) => {
          return this.mapping[name] === ctx.mapping[name]
        }

        // check override
        if (value && oldValue && typeof name === 'string') {
          throw new Error(`service ${name} has been registered`)
        }

        if (typeof name === 'string') {
          this.emit(self, 'internal/before-service', name, value)
        }
        this.root[key] = value
        if (value && typeof value === 'object') {
          defineProperty(value, Context.source, this)
        }
        if (typeof name === 'string') {
          this.emit(self, 'internal/service', name, oldValue)
        }
      },
    })

    if (isConstructor(options)) {
      const internal = ensureInternal(this.prototype)
      internal[privateKey] = options
    }

    this.mixin(name, options)
  }

  function ensureInternal(prototype: {}) {
    if (Object.prototype.hasOwnProperty.call(prototype, Context.internal)) {
      return prototype[Context.internal]
    }
    const parent = ensureInternal(Object.getPrototypeOf(prototype))
    return prototype[Context.internal] = Object.create(parent)
  }
}

Context.prototype[Context.internal] = Object.create(null)

Context.service('registry', Registry)
Context.service('lifecycle', Lifecycle)

Context.mixin('state', {
  properties: ['config', 'runtime'],
  methods: ['collect', 'accept', 'decline'],
})
