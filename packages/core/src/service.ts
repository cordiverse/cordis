import { defineProperty, isNullable } from 'cosmokit'
import { Context } from './context.ts'
import { locate } from './reflect.ts'
import { createCallable, joinPrototype, symbols, Tracker } from './utils.ts'

export abstract class Service<out T = never> {
  static readonly init: unique symbol = symbols.init
  static readonly check: unique symbol = symbols.check
  static readonly invoke: unique symbol = symbols.invoke
  static readonly metadata: unique symbol = symbols.metadata
  static readonly extend: unique symbol = symbols.extend
  static readonly tracker: unique symbol = symbols.tracker
  static readonly mergeIntercept: unique symbol = symbols.mergeIntercept
  static readonly resolveIntercept: unique symbol = symbols.resolveIntercept

  declare [symbols.metadata]: T

  public name!: string

  constructor(protected ctx: Context, name: string) {
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

    self.ctx.reflect.provide(name, self, this[symbols.check])
    return self
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

  [symbols.mergeIntercept](...values: T[]): T {
    return Object.assign({}, ...values)
  }

  [symbols.resolveIntercept](): T {
    const values: T[] = []
    let intercept = this.ctx[Context.intercept]
    while (this.name in intercept) {
      if (Object.hasOwn(intercept, this.name)) {
        values.unshift(intercept[this.name])
      }
      intercept = Object.getPrototypeOf(intercept)
    }
    const value = locate((this as any)[symbols.caller] ?? this.ctx, this.name)?.fiber?.inject[this.name]
    if (!isNullable(value)) values.unshift(value)
    const merge = this[symbols.mergeIntercept] ?? Service.prototype[symbols.mergeIntercept]
    return merge.apply(this, values)
  }

  static [Symbol.hasInstance](instance: any) {
    if (!instance) return false
    let constructor = instance.constructor
    while (constructor) {
      // constructor may be a proxy
      constructor = constructor.prototype?.constructor
      if (constructor === this) return true
      constructor &&= Object.getPrototypeOf(constructor)
    }
    return false
  }
}
