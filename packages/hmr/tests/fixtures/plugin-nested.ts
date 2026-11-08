import { Context } from 'cordis'
import { version } from './tree-dep.ts'

// Counters must survive module reloads, so they live on `globalThis`.
const stats: any = ((globalThis as any).__hmrTest ??= {})

export const name = 'plugin-nested'

export function apply(ctx: Context) {
  stats.nestedApplied = (stats.nestedApplied ?? 0) + 1
  ctx.on('hmr-test/get-nested', () => version)
  ctx.effect(() => () => {
    stats.nestedDisposed = (stats.nestedDisposed ?? 0) + 1
  })
}
