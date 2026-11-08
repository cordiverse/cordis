import { Context } from 'cordis'

const stats: any = ((globalThis as any).__hmrTest ??= {})

export const name = 'plugin-multi'

export let version = 'multi-v1'

/**
 * Loaded by two entries at once, so its runtime holds two fibers. Each
 * instance answers only for its own label, which lets a test query them
 * independently and check that each kept its own config across a reload.
 */
export function apply(ctx: Context, config: { label: string }) {
  ;(stats.multiApplies ??= []).push(`${config.label}:${version}`)
  ctx.on('hmr-test/get-multi', (label: string) => {
    return label === config.label ? version : undefined
  })
}
