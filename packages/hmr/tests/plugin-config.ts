import { Context } from 'cordis'

export const name = 'plugin-config'

export function apply(ctx: Context, config: any) {
  ctx.on('hmr-test/get-config', () => config)
}
