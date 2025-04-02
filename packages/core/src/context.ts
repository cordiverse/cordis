import { Dict } from 'cosmokit'
import { EventsService } from './events'
import { ReflectService } from './reflect'
import { InjectKey, RegistryService } from './registry'
import { getTraceable, symbols } from './utils'
import { Fiber } from './fiber'

export interface Context {
  [symbols.isolate]: Dict<symbol>
  [symbols.intercept]: Dict
  /** @experimental */
  root: this
  events: EventsService
  reflect: ReflectService<this>
  registry: RegistryService<this>
}

export class Context {
  static readonly effect: unique symbol = symbols.effect
  static readonly events: unique symbol = symbols.events
  static readonly filter: unique symbol = symbols.filter
  static readonly isolate: unique symbol = symbols.isolate
  static readonly intercept: unique symbol = symbols.intercept

  /** @deprecated */
  static readonly init = symbols.init

  static is<C extends Context>(value: any): value is C {
    return !!value?.[Context.is as any]
  }

  static {
    Context.is[Symbol.toPrimitive] = () => Symbol.for('cordis.is')
    Context.prototype[Context.is as any] = true
  }

  constructor() {
    this[symbols.isolate] = Object.create(null)
    this[symbols.intercept] = Object.create(null)
    const self = new Proxy<this>(this, ReflectService.handler)
    this.root = self
    this.fiber = new Fiber(self, {}, Object.create(null), null, () => [])
    this.reflect = new ReflectService(self)
    this.registry = new RegistryService(self)
    this.events = new EventsService(self)
    this.fiber._disposables.clear()
    return self
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Context <${this.fiber.name}>`
  }

  extend(meta = {}): this {
    const shadow = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value
    const self = Object.create(getTraceable(this, this))
    for (const prop of Reflect.ownKeys(meta)) {
      Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop)!)
    }
    if (!shadow) return self
    return Object.assign(Object.create(self), { [symbols.shadow]: shadow })
  }

  isolate(name: string, label?: symbol) {
    const shadow = Object.create(this[symbols.isolate])
    shadow[name] = label ?? Symbol(name)
    return this.extend({ [symbols.isolate]: shadow })
  }

  intercept<K extends InjectKey<this>>(name: K, config: this[K] extends { [symbols.config]: infer T } ? T : never): this
  intercept(name: string, config: any): this
  intercept(name: string, config: any) {
    const intercept = Object.create(this[symbols.intercept])
    intercept[name] = config
    return this.extend({ [symbols.intercept]: intercept })
  }
}
