import { Context } from 'cordis'

export const name = 'test-component'

export let value = 'default'

export function apply(ctx: Context) {
  ctx.on('test/get-value', () => value)
}
