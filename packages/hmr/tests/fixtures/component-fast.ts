import { Context } from 'cordis'
import { version } from './drain-dep.ts'

declare module 'cordis' {
  interface Events {
    'hmr-test/get-fast'(): string
  }
}

const stats: any = ((globalThis as any).__hmrTest ??= {})

export const name = 'component-fast'

/** Unloads instantly; must not be held back by component-slow's drain. */
export function apply(ctx: Context) {
  stats.fastAppliedAt = Date.now()
  ctx.on('hmr-test/get-fast', () => version)
}
