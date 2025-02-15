import { use } from 'chai'
import { Context, Service } from '../src'
import promised from 'chai-as-promised'
import { Dict } from 'cosmokit'

use(promised)

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
  for (const [name, callbacks] of Object.entries(ctx.events._hooks)) {
    if (callbacks.length) result[name] = callbacks.length
  }
  return result
}
