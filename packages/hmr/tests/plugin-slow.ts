import { Context } from 'cordis'
import { version } from './drain-dep.ts'

const stats: any = ((globalThis as any).__hmrTest ??= {})

export const name = 'plugin-slow'

/** Models a plugin that owns an exclusive resource and releases it slowly. */
export function apply(ctx: Context) {
  if (stats.slowHeld) stats.slowOverlaps = (stats.slowOverlaps ?? 0) + 1
  stats.slowHeld = true
  ctx.on('hmr-test/get-slow', () => version)
  ctx.effect(() => async () => {
    stats.slowDisposeStartedAt = Date.now()
    await new Promise(resolve => setTimeout(resolve, 300))
    stats.slowHeld = false
    stats.slowReleasedAt = Date.now()
  })
}
