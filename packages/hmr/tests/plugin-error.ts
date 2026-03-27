import { Context } from 'cordis'

export const name = 'plugin-error'

export let value = 'ok'

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-error', () => value)
}
