import { Awaitable, defineProperty } from 'cosmokit'
import { Context } from './context.ts'

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
  for (const key of Reflect.ownKeys(proto)) {
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
    let self = this
    if (self[Context.invoke]) {
      // functional service
      self = function (...args: any[]) {
        const proxy = Context.createProxy(ctx, self)
        return Context.applyProxy(proxy, self, this, args)
      } as any
      defineProperty(self, 'name', name)
      Object.setPrototypeOf(self, makeFunctional(Object.getPrototypeOf(this)))
    }

    self.ctx = ctx ?? new (self.constructor as any).Context()
    self.ctx.provide(name)
    defineProperty(self, Context.current, ctx)

    const resolved = typeof options === 'boolean' ? { immediate: options } : options ?? {}
    if (!resolved.standalone && resolved.immediate) {
      if (ctx) self[Context.expose] = name
      else self.ctx[name] = self
    }

    self.ctx.on('ready', async () => {
      // await until next tick because derived class has not been initialized yet
      await Promise.resolve()
      await self.start()
      if (!resolved.standalone && !resolved.immediate) self.ctx[name] = self
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
}
