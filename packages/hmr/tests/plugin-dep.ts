import { Context } from 'cordis'
import { sharedValue } from './dep.ts'
import { commonValue } from './dep-common.ts'

export const name = 'plugin-dep'

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-dep', () => sharedValue)
  ctx.on('hmr-test/get-dep-common', () => commonValue)
  ctx.effect(() => () => {
    ctx.root.emit('hmr-test/disposed-dep')
  })
}
