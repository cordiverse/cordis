import { use } from 'chai'
import { Context } from '../src'
import promised from 'chai-as-promised'
import { Dict } from 'cosmokit'

use(promised)

Context.service('foo')

export const event = Symbol('custom-event')

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

export function filter(ctx: Context) {
  ctx.root.filter = () => true
  ctx.on('internal/runtime', (runtime) => {
    // same as `!runtime.uid`, but to make coverage happy
    if (!ctx.registry.has(runtime.plugin)) return
    runtime.ctx.filter = (session) => {
      return runtime.children.some((child) => {
        return child.ctx.filter(session)
      })
    }
  })
}

declare module '../src/events' {
  interface Events {
    [event](this: Session): void
  }
}

declare module '../src/context' {
  interface Context {
    foo: any
    filter(session: Session): boolean
  }
}

export function getHookSnapshot(ctx: Context) {
  const result: Dict<number> = {}
  for (const [name, callbacks] of Object.entries(ctx.events._hooks)) {
    if (callbacks.length) result[name] = callbacks.length
  }
  return result
}
