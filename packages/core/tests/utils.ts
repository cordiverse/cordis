import { vi } from 'vitest'
import { Context, Service } from '../src'
import { Awaitable, Dict } from 'cosmokit'

export function withTimers(fn: (ctx: Context) => Awaitable<void>, config?: { now?: number | Date }) {
  return async () => {
    const ctx = new Context()
    vi.useFakeTimers(config)
    try {
      await fn(ctx)
    } finally {
      vi.useRealTimers()
    }
  }
}

export function sleep(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export const event = 'custom-event'

export class Session {
  constructor(public flag: boolean) {}

  [Context.filter](context: Context) {
    if (!context.filter) return true
    return context.filter(this)
  }
}

export class Filter {
  constructor(private flag: boolean) {}

  filter = (session: Session) => {
    // basic parity check
    return session.flag === this.flag
  }
}

declare module '../src/events' {
  interface Events {
    [event](): void
    'test/waterfall'(value: number, next: () => number): number
    '__proto__'(): void
    'toString'(): void
    'constructor'(): void
  }
}

export class Counter {
  [Service.tracker] = {
    associate: 'counter',
    property: 'ctx',
  }

  value = 0

  constructor(public ctx: Context) {}

  increase() {
    return this.ctx.effect(() => {
      this.value++
      return () => this.value--
    })
  }
}

declare module '../src/context' {
  interface Context {
    foo: any
    bar: any
    baz: any
    qux: any
    counter: Counter
    session: any
    filter(session: Session): boolean
  }

  interface Intercept {
    foo: any
  }
}

export function getHookSnapshot(ctx: Context) {
  const result: Dict<number> = {}
  // `Reflect.ownKeys` rather than `Object.entries`, so that symbol-named events are visible to the leak checks
  for (const name of Reflect.ownKeys(ctx.events._hooks)) {
    const callbacks = ctx.events._hooks[name]
    if (callbacks.length) result[name.toString()] = callbacks.length
  }
  return result
}
