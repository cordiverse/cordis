import { defineProperty, Dict } from 'cosmokit'
import Lifecycle from './events.ts'
import ReflectService from './reflect.ts'
import Registry from './registry.ts'
import { getTraceable, resolveConfig, symbols } from './utils.ts'

export { Lifecycle, ReflectService, Registry }

export namespace Context {
  export type Parameterized<C, T = any> = C & { config: T }

  /** @deprecated use `string[]` instead */
  export interface MixinOptions {
    methods?: string[]
    accessors?: string[]
    prototype?: {}
  }

  export interface Item<C extends Context> {
    value?: any
    source: C
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
      get: (this: Context, receiver: any) => any
      set?: (this: Context, value: any, receiver: any) => boolean
    }

    export interface Alias {
      type: 'alias'
      name: string
    }
  }
}

// https://github.com/typescript-eslint/typescript-eslint/issues/6720
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface Intercept<C extends Context = Context> {}

export interface Context {
  [Context.store]: Dict<Context.Item<this>, symbol>
  [Context.isolate]: Dict<symbol>
  [Context.intercept]: Intercept<this>
  [Context.internal]: Dict<Context.Internal>
  root: this
  lifecycle: Lifecycle
  reflect: ReflectService
  registry: Registry<this>
  config: any
}

export class Context {
  static readonly store: unique symbol = symbols.store as any
  static readonly events: unique symbol = symbols.events as any
  static readonly static: unique symbol = symbols.static as any
  static readonly filter: unique symbol = symbols.filter as any
  static readonly expose: unique symbol = symbols.expose as any
  static readonly isolate: unique symbol = symbols.isolate as any
  static readonly internal: unique symbol = symbols.internal as any
  static readonly intercept: unique symbol = symbols.intercept as any
  static readonly origin = 'ctx'
  static readonly current = 'ctx'

  static is<C extends Context>(value: any): value is C {
    return !!value?.[Context.is as any]
  }

  static {
    Context.is[Symbol.toPrimitive] = () => Symbol.for('cordis.is')
    Context.prototype[Context.is as any] = true
  }

  /** @deprecated use `Service.traceable` instead */
  static associate<T extends {}>(object: T, name: string) {
    return object
  }

  constructor(config?: any) {
    config = resolveConfig(this.constructor, config)
    this[symbols.store] = Object.create(null)
    this[symbols.isolate] = Object.create(null)
    this[symbols.internal] = Object.create(null)
    this[symbols.intercept] = Object.create(null)
    const self: Context = new Proxy(this, ReflectService.handler)
    self.root = self
    self.reflect = new ReflectService(self)
    self.registry = new Registry(self, config)
    self.lifecycle = new Lifecycle(self)

    const attach = (internal: Context[typeof symbols.internal]) => {
      if (!internal) return
      attach(Object.getPrototypeOf(internal))
      for (const key of Object.getOwnPropertyNames(internal)) {
        const constructor = internal[key]['prototype']?.constructor
        if (!constructor) continue
        self[internal[key]['key']] = new constructor(self, config)
        defineProperty(self[internal[key]['key']], 'ctx', self)
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

  extend(meta = {}): this {
    const source = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value
    const self = Object.assign(Object.create(getTraceable(this, this)), meta)
    if (!source) return self
    return Object.assign(Object.create(self), { [symbols.shadow]: source })
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
