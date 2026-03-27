import { Context } from 'cordis'

export const name = 'test-plugin-event'

export let value = 'initial'

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-event', () => value)
  ctx.effect(() => () => {
    ctx.root.emit('hmr-test/disposed-event')
  })
}
