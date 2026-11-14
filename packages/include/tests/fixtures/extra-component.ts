import { Context } from 'cordis'

declare module 'cordis' {
  interface Events {
    'test/get-extra'(): string
  }
}

export const name = 'extra-component'

export function apply(ctx: Context) {
  ctx.on('test/get-extra', () => 'extra')
}
