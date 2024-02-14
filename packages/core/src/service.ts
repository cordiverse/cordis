import { Awaitable, defineProperty } from 'cosmokit'
import { Context } from './context.ts'

const kSetup = Symbol.for('cordis.service.setup')

export namespace Service {
  export interface Options {
    name?: string
    immediate?: boolean
    standalone?: boolean
  }
}

function makeFunctional(proto: {}) {
  if (proto === Object.prototype) return Function.prototype
  const result = Object.create(makeFunctional(Object.getPrototypeOf(proto)))
  for (const key of Object.getOwnPropertyNames(proto)) {
    Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto, key)!)
  }
  for (const key of Object.getOwnPropertySymbols(proto)) {
    Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto, key)!)
  }
  return result
}

export abstract class Service<C extends Context = Context> {
  static immediate = false
  static Context = Context

  protected start(): Awaitable<void> {}
  protected stop(): Awaitable<void> {}
  protected fork?(ctx: C, config: any): void

  protected ctx!: C
  protected [Context.current]!: C

  constructor(ctx: C | undefined, public readonly name: string, options?: boolean | Service.Options) {
    let self: any = this
    if (self[Context.invoke]) {
      // functional service
      self = function (...args: any[]) {
        const proxy = Context.createProxy(ctx, self)
        return Context.applyProxy(proxy, self, this, args)
      }
      defineProperty(self, 'name', name)
      Object.setPrototypeOf(self, makeFunctional(Object.getPrototypeOf(this)))
    }
    return self[kSetup](ctx, name, options)
  }

  [Context.filter](ctx: Context) {
    return ctx[Context.shadow][this.name] === this.ctx[Context.shadow][this.name]
  }

  [kSetup](ctx: C | undefined, name: string, options?: boolean | Service.Options) {
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
}
