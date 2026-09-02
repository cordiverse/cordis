import { Context } from 'cordis'
import { version } from './drain-dep.ts'

const stats: any = ((globalThis as any).__hmrTest ??= {})

export const name = 'plugin-fast'

/** Unloads instantly; must not be held back by plugin-slow's drain. */
export function apply(ctx: Context) {
  stats.fastAppliedAt = Date.now()
  ctx.on('hmr-test/get-fast', () => version)
}
