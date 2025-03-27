import { Dict } from 'cosmokit'
import EventsService from './events'
import ReflectService from './reflect'
import Registry from './registry'
import { getTraceable, symbols } from './utils'
import { EffectScope } from './scope'

export { EventsService, ReflectService, Registry }

export namespace Context {
  export interface Item<C extends Context> {
    name: string
    value?: any
    source: C
  }

  export type Internal = Internal.Service | Internal.Accessor | Internal.Alias

  export namespace Internal {
    export interface Service {
      type: 'service'
    }

    export interface Accessor {
      type: 'accessor'
      get: (this: Context, receiver: any, error: Error) => any
      set?: (this: Context, value: any, receiver: any, error: Error) => boolean
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
  [symbols.store]: Dict<Context.Item<this>, symbol>
  [symbols.isolate]: Dict<symbol>
  [symbols.intercept]: Intercept<this>
  [symbols.internal]: Dict<Context.Internal>
  root: this
  events: EventsService
  reflect: ReflectService
  registry: Registry<this>
}

export class Context {
  static readonly store: unique symbol = symbols.store as any
  static readonly effect: unique symbol = symbols.effect as any
  static readonly events: unique symbol = symbols.events as any
  static readonly filter: unique symbol = symbols.filter as any
  static readonly isolate: unique symbol = symbols.isolate as any
  static readonly internal: unique symbol = symbols.internal as any
  static readonly intercept: unique symbol = symbols.intercept as any

  static is<C extends Context>(value: any): value is C {
    return !!value?.[Context.is as any]
  }

  static {
    Context.is[Symbol.toPrimitive] = () => Symbol.for('cordis.is')
    Context.prototype[Context.is as any] = true
  }

  constructor() {
    this[symbols.store] = Object.create(null)
    this[symbols.isolate] = Object.create(null)
    this[symbols.internal] = Object.create(null)
    this[symbols.intercept] = Object.create(null)
    const self: Context = new Proxy(this, ReflectService.handler)
    self.root = self
    self.scope = new EffectScope(self, {}, {}, null, () => [])
    self.reflect = new ReflectService(self)
    self.registry = new Registry(self)
    self.events = new EventsService(self)
    // ignore internal effects
    self.scope.disposables.clear()
    return self
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Context <${this.name}>`
  }

  get name() {
    let scope = this.scope
    do {
      if (scope.runtime?.name) return scope.runtime.name
      scope = scope.parent.scope
    } while (scope !== scope.parent.scope)
    return 'root'
  }

  extend(meta = {}): this {
    const shadow = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value
    const self = Object.assign(Object.create(getTraceable(this, this)), meta)
    if (!shadow) return self
    return Object.assign(Object.create(self), { [symbols.shadow]: shadow })
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
