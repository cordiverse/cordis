import { Context } from 'cordis'

export const name = 'plugin-b'

export let value = 'beta'

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-b', () => value)
  ctx.effect(() => () => {
    ctx.root.emit('hmr-test/disposed-b')
  })
}
