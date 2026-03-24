import { Context } from 'cordis'

export const name = 'test-plugin'

export let value = 'initial'

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-value', () => value)
  ctx.effect(() => () => {
    ctx.root.emit('hmr-test/disposed')
  })
}
