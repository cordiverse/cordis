import { Context } from '../src'

declare const ctx: Context
declare const dynamicEvent: symbol
declare const ready: unique symbol

declare module '../src/events' {
  interface Events {
    [ready](count: number): string
  }
}

ctx.bail(ready, 1).toUpperCase()
ctx.on(ready, count => count.toFixed())

// @ts-expect-error registered symbol events retain their declared parameters
ctx.bail(ready, 'wrong')
// @ts-expect-error registered symbol listeners retain their declared parameters
ctx.on(ready, (count: string) => count.length)

ctx.emit(dynamicEvent, 'dynamic', 1)
ctx.on(dynamicEvent, (...args) => args)
