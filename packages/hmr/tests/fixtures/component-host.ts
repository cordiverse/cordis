import { Context } from 'cordis'

export const name = 'component-host'

// Does not import the user component, so a change there does not stale this entry.
export function apply(ctx: Context) {
  const shared = (globalThis as any).__hmrShared
  if (!shared) throw new Error('shared component missing')
  ctx.use(shared)
}
