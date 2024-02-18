import { Awaitable, defineProperty } from 'cosmokit'
import { Context } from './context.ts'
import { createCallable, joinPrototype, symbols } from './index.ts'

export abstract class Service<T = unknown, C extends Context = Context> {
  static readonly init: unique symbol = symbols.init as any
  static readonly setup: unique symbol = symbols.setup as any
  static readonly invoke: unique symbol = symbols.invoke as any
  static readonly extend: unique symbol = symbols.extend as any
  static readonly provide: unique symbol = symbols.provide as any
  static readonly immediate: unique symbol = symbols.immediate as any

  protected start(): Awaitable<void> {}
  protected stop(): Awaitable<void> {}
  protected fork?(ctx: C, config: any): void

  protected ctx!: C
  protected [Context.trace]!: C

  public name!: string
  public config!: T

  constructor(config: T)
  constructor(ctx: C | undefined, config: T)
  constructor(ctx: C | undefined, name: string, immediate?: boolean)
  constructor(...args: any[]) {
    let _ctx: C | undefined, name: string | undefined, immediate: boolean | undefined, config: any
    if (Context.is<C>(args[0])) {
      _ctx = args[0]
      if (typeof args[1] === 'string') {
        name = args[1]
        immediate = args[2]
      } else {
        config = args[1]
      }
    } else {
      config = args[0]
    }
    name ??= this.constructor[symbols.provide] as string
    immediate ??= this.constructor[symbols.immediate]

    let self = this
    if (self[symbols.invoke]) {
      self = createCallable(name, joinPrototype(Object.getPrototypeOf(this), Function.prototype))
    }
    if (_ctx) {
      self.ctx = _ctx
    } else {
      self[symbols.setup]()
    }
    self.name = name
    self.config = config
    defineProperty(self, symbols.trace, self.ctx)
    self[symbols.init]()

    self.ctx.provide(name)
    self.ctx.runtime.name = name
    if (immediate) {
      if (_ctx) self[Context.expose] = name
      else self.ctx[name] = self
    }

    self.ctx.on('ready', async () => {
      // await until next tick because derived class has not been initialized yet
      await Promise.resolve()
      await self.start()
      if (!immediate) self.ctx[name!] = self
    })

    self.ctx.on('dispose', () => self.stop())
    return Context.associate(self, name)
  }

  [Context.filter](ctx: Context) {
    return ctx[Context.shadow][this.name] === this.ctx[Context.shadow][this.name]
  }

  static [Symbol.hasInstance](instance: any) {
    let constructor = instance.constructor
    while (constructor) {
      if (constructor === this) return true
      constructor = Object.getPrototypeOf(constructor)
    }
    return false
  }

  [symbols.setup]() {
    this.ctx = new Context() as C
  }

  [symbols.init]() {}

  [symbols.extend](props?: any) {
    const caller = this[Context.trace]
    let self: any
    if (this[Service.invoke]) {
      self = createCallable(this.name, this)
    } else {
      self = Object.create(this)
    }
    defineProperty(self, Context.trace, caller)
    return Context.associate(Object.assign(self, props), this.name)
  }
}
