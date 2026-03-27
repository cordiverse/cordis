import { Context } from 'cordis'

export const name = 'plugin-a'

export let value = 'alpha'

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-a', () => value)
  ctx.effect(() => () => {
    ctx.root.emit('hmr-test/disposed-a')
  })
}
