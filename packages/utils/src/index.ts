import { Context, Service } from 'cordis'
import { defineProperty } from 'cosmokit'

export class List<T> {
  private sn = 0
  private inner = new Map<number, T>()

  constructor(public ctx: Context, private trace: string) {
    defineProperty(this, Service.tracker, { property: 'ctx' })
  }

  get length() {
    return this.inner.size
  }

  push(value: T) {
    this.ctx.effect(() => {
      this.inner.set(++this.sn, value)
      return () => this.inner.delete(this.sn)
    }, `${this.trace}.push()`)
  }

  * filter(predicate: (value: T) => boolean) {
    for (const value of this.inner.values()) {
      if (predicate(value)) yield value
    }
  }

  * map<U>(mapper: (value: T) => U) {
    for (const value of this.inner.values()) {
      yield mapper(value)
    }
  }

  [Symbol.iterator]() {
    return this.inner.values()
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return [...this]
  }
}
