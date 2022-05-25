import { use } from 'chai'
import { Context, Filter } from '../src'
import shape from 'chai-shape'

use(shape)

Context.service('foo')

export const event = Symbol('custom-event')
export const filter: Filter = session => session.flag

declare module '../src/lifecycle' {
  interface Events {
    [event](): void
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
