import { Context } from 'cordis'

export const name = 'extra-component'

export function apply(ctx: Context) {
  ctx.on('test/get-extra', () => 'extra')
}
