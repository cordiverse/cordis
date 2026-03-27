import { Context } from 'cordis'
import { sharedValue } from './dep.ts'

export const name = 'plugin-dep'

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-dep', () => sharedValue)
  ctx.effect(() => () => {
    ctx.root.emit('hmr-test/disposed-dep')
  })
}
