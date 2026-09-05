import { Context } from 'cordis'
import { commonValue } from './dep-common.ts'

const stats: any = ((globalThis as any).__hmrTest ??= {})

export const name = 'plugin-dep-sibling'

/**
 * Listed after plugin-dep and sharing dep-common.ts with it, but never
 * importing dep.ts. A change to dep.ts must leave this plugin alone.
 */
export function apply(ctx: Context) {
  stats.depSiblingApplied = (stats.depSiblingApplied ?? 0) + 1
  ctx.on('hmr-test/get-dep-sibling', () => commonValue)
}
