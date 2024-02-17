import { Awaitable, defineProperty } from 'cosmokit'
import { Context } from './context.ts'

export namespace Service {
  export interface Options {
    name?: string
    immediate?: boolean
  }
}

function makeCallableProto(proto: {}) {
  if (proto === Object.prototype) return Function.prototype
  const result = Object.create(makeCallableProto(Object.getPrototypeOf(proto)))
  for (const key of Reflect.ownKeys(proto)) {
    Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto, key)!)
  }
  return result
}

function makeCallable(ctx: Context, name: string, proto: {}) {
  const self = function (...args: any[]) {
    const proxy = Context.createTraceable(ctx, self)
    return Context.applyTraceable(proxy, self, this, args)
  }
  defineProperty(self, 'name', name)
  return Object.setPrototypeOf(self, proto)
}

export abstract class Service<C extends Context = Context, T = unknown> {
  static immediate = false
  static Context = Context

  protected start(): Awaitable<void> {}
  protected stop(): Awaitable<void> {}
  protected fork?(ctx: C, config: any): void

  protected ctx!: C
  protected [Context.current]!: C

  constructor(ctx: C | undefined, public readonly name: string, options?: boolean) {
    let self = this
    if (self[Context.invoke]) {
      // FIXME ctx!
      self = makeCallable(ctx!, name, makeCallableProto(Object.getPrototypeOf(this)))
    }

    self.ctx = ctx ?? new (self.constructor as any).Context()
    defineProperty(self, Context.current, ctx)

    const resolved = typeof options === 'boolean' ? { immediate: options } : options ?? {}
    if (resolved.immediate) {
      self.ctx.provide(name)
      self.ctx.runtime.name = name
      if (ctx) self[Context.expose] = name
      else self.ctx[name] = self
    }

    self.ctx.on('ready', async () => {
      // await until next tick because derived class has not been initialized yet
      await Promise.resolve()
      await self.start()
      if (!resolved.immediate) self.ctx[name] = self
    })

    self.ctx.on('dispose', () => self.stop())
    return Context.associate(self, name)
  }

  [Context.filter](ctx: Context) {
    return ctx[Context.shadow][this.name] === this.ctx[Context.shadow][this.name]
  }

  [Context.extend](props?: any) {
    const caller = this[Context.current]
    let self: typeof this
    if (this[Context.invoke]) {
      self = makeCallable(caller, this.name, this)
    } else {
      self = Object.create(this)
    }
    defineProperty(self, Context.current, caller)
    return Context.associate(Object.assign(self, props), this.name)
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
