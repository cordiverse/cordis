import { Context } from 'cordis'

declare module 'cordis' {
  interface Events {
    'test/get-value'(): string
  }
}

export const name = 'test-component'

export let value = 'default'

export function apply(ctx: Context) {
  ctx.on('test/get-value', () => value)
}
