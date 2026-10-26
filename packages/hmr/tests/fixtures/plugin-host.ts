import { Context } from 'cordis'

export const name = 'plugin-host'

// Does not import the user plugin, so a change there does not stale this entry.
export function apply(ctx: Context) {
  const shared = (globalThis as any).__hmrShared
  if (!shared) throw new Error('shared plugin missing')
  ctx.plugin(shared)
}
