import { use } from 'chai'
import { Context } from '../src'
import promised from 'chai-as-promised'

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

export function union(ctx: Context) {
  ctx.app.filter = () => true
  ctx.on('internal/runtime', (runtime) => {
    // same as `!runtime.uid`, but to make coverage happy
    if (!ctx.registry.has(runtime.plugin)) return
    runtime.context.filter = (session) => {
      return runtime.children.some((child) => {
        return child.context.filter(session)
      })
    }
  })
}

declare module '../src/lifecycle' {
  interface Events {
    [event](this: Session): void
  }
}

declare module '../src/context' {
  interface Context {
    foo: any
  }

  namespace Context {
    interface Meta {
      filter(session: Session): boolean
    }
  }
}
