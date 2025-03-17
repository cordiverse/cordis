import { Awaitable, defineProperty, formatProperty } from 'cosmokit'
import { Context } from './context'
import { createCallable, joinPrototype, symbols, Tracker } from './utils'

export function Init() {
  return function (value: any, decorator: ClassMethodDecoratorContext<any>) {
    if (decorator.kind === 'method') {
      decorator.addInitializer(function () {
        const label = `new ${this.constructor.name}()${formatProperty(decorator.name)}()`
        ;(this[symbols.initHooks] ??= []).push(() => {
          (this.ctx as Context).effect(() => value.call(this), label)
        })
      })
    } else {
      throw new Error('@Init() can only be used on class methods')
    }
  }
}

export abstract class Service<out C extends Context = Context> {
  static readonly check: unique symbol = symbols.check as any
  static readonly setup: unique symbol = symbols.setup as any
  static readonly invoke: unique symbol = symbols.invoke as any
  static readonly extend: unique symbol = symbols.extend as any
  static readonly tracker: unique symbol = symbols.tracker as any
  static readonly provide = 'provide' as any

  protected start(): Awaitable<void> {}
  protected stop(): Awaitable<void> {}

  public name!: string

  constructor(protected ctx: C, name: string) {
    name ??= this.constructor['provide'] as string

    let self = this
    const tracker: Tracker = {
      associate: name,
      property: 'ctx',
    }
    if (self[symbols.invoke]) {
      self = createCallable(name, joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker)
    }
    self.ctx = ctx
    self.name = name
    defineProperty(self, symbols.tracker, tracker)

    self.ctx.set(name, self)
    return self
  }

  protected [symbols.setup]() {
    return this.start()
  }

  protected [symbols.filter](ctx: Context) {
    return ctx[symbols.isolate][this.name] === this.ctx[symbols.isolate][this.name]
  }

  protected [symbols.extend](props?: any) {
    let self: any
    if (this[Service.invoke]) {
      self = createCallable(this.name, this, this[symbols.tracker])
    } else {
      self = Object.create(this)
    }
    return Object.assign(self, props)
  }

  static [Symbol.hasInstance](instance: any) {
    let constructor = instance.constructor
    while (constructor) {
      // constructor may be a proxy
      constructor = constructor.prototype?.constructor
      if (constructor === this) return true
      constructor = Object.getPrototypeOf(constructor)
    }
    return false
  }
}
