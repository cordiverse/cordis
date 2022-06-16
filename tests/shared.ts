import { use } from 'chai'
import { Context, Filter } from '../src'
import promised from 'chai-as-promised'

use(promised)

Context.service('foo')

export const event = Symbol('custom-event')
export const filter: Filter = session => session.flag

export class Session {
  constructor(public flag: boolean) {}

  [Context.filter](context: Context) {
    return context.filter(this)
  }
}

declare module '../src/lifecycle' {
  interface Events {
    [event](): void
    'before-custom'(): void
  }

  namespace Lifecycle {
    interface Session {
      flag: boolean
    }
  }
}

declare module '../src/context' {
  interface Context {
    foo: any
  }
}
