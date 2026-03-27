import { Context } from 'cordis'

export const name = 'extra-plugin'

export function apply(ctx: Context) {
  ctx.on('test/get-extra', () => 'extra')
}
