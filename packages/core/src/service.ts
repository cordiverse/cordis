import { Awaitable, defineProperty } from 'cosmokit'
import { Context } from './context.ts'

const kSetup = Symbol('cordis.service.setup')

export namespace Service {
  export interface Options {
    immediate?: boolean
    standalone?: boolean
  }
}

export abstract class Service<C extends Context = Context> {
  static Context = Context

  public [kSetup](ctx: C | undefined, name: string, options?: boolean | Service.Options) {
    this.ctx = ctx ?? new (this.constructor as any).Context()
    this.ctx.provide(name)
    defineProperty(this, Context.current, ctx)

    const resolved = typeof options === 'boolean' ? { immediate: options } : options ?? {}
    if (!resolved.standalone && resolved.immediate) {
      if (ctx) this[Context.expose] = name
      else this.ctx[name] = this
    }

    this.ctx.on('ready', async () => {
      // await until next tick because derived class has not been initialized yet
      await Promise.resolve()
      await this.start()
      if (!resolved.standalone && !resolved.immediate) this.ctx[name] = this
    })

    this.ctx.on('dispose', () => this.stop())

    return Context.associate(this, name)
  }

  protected start(): Awaitable<void> {}
  protected stop(): Awaitable<void> {}
  protected fork?(ctx: C, config: any): void

  protected ctx!: C
  protected [Context.current]!: C

  constructor(ctx: C | undefined, public readonly name: string, options?: boolean | Service.Options) {
    return this[kSetup](ctx, name, options)
  }

  [Context.filter](ctx: Context) {
    return ctx[Context.shadow][this.name] === this.ctx[Context.shadow][this.name]
  }
}

export interface FunctionalService {
  (...args: this['call'] extends (thisArg: any, ...rest: infer R) => any ? R : never): ReturnType<this['call']>
}

export abstract class FunctionalService<C extends Context = Context> extends Function {
  static Context = Context

  abstract call(ctx: C, ...args: any[]): any

  protected start(): Awaitable<void> {}
  protected stop(): Awaitable<void> {}
  protected fork?(ctx: C, config: any): void

  protected ctx!: C
  protected [Context.current]!: C

  constructor(ctx: C | undefined, name: string, options?: boolean | Service.Options) {
    super()
    const self = function (this: C, ...args: any[]) {
      return self.call(ctx, ...args)
    }
    defineProperty(self, 'name', name)
    Object.setPrototypeOf(self, Object.getPrototypeOf(this))
    return Service.prototype[kSetup].call(self, ctx, name, options) as any
  }
}
