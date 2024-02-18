import { Awaitable, defineProperty } from 'cosmokit'
import { Context } from './context.ts'
import { appendFunctionPrototype, createCallable, kInvoke } from './index.ts'

export interface Service {
  [Service.setup](): void
  [Service.extend](props?: any): this
}

export abstract class Service<C extends Context = Context, T = unknown> {
  static readonly setup = Symbol.for('cordis.setup')
  static readonly invoke: unique symbol = kInvoke as any
  static readonly extend = Symbol.for('cordis.extend')
  static readonly provide = Symbol.for('cordis.provide')
  static readonly immediate = Symbol.for('cordis.immediate')

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
    name ??= this.constructor[Service.provide] as string
    immediate ??= this.constructor[Service.immediate]

    let self = this
    if (self[Service.invoke]) {
      self = createCallable(name, appendFunctionPrototype(Object.getPrototypeOf(this)))
    }
    self.ctx = _ctx!
    self.name = name
    self.config = config
    self[Service.setup]()

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

  static {
    Service.prototype[Service.extend] = function (props?: any) {
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

    Service.prototype[Service.setup] = function (this: Service) {
      this.ctx ??= new Context()
      defineProperty(this, Context.trace, this.ctx)
    }
  }
}
