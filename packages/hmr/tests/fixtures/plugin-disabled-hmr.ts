import { Context } from 'cordis'

export const name = 'plugin-disabled-hmr'

export let value = 'initial'

type Gate = {
  acquired: number
  applies: number
  fibers: { uid: number | null }[]
  hold?: Promise<void>
  entered?: () => void
}

function gate(): Gate | undefined {
  return (globalThis as any).__hmrGate
}

export function apply(ctx: Context) {
  // A host that does not import this file can still mount the same callback.
  ;(globalThis as any).__hmrShared = apply
  const current = gate()
  if (current) {
    current.acquired++
    current.applies++
    current.fibers.push(ctx.fiber)
  }
  const off = ctx.on('hmr-test/get-value', () => value)
  // `apply` is invoked as a constructor, so a returned disposer is discarded.
  ctx.effect(() => () => {
    off()
    if (current) {
      current.acquired--
      const index = current.fibers.indexOf(ctx.fiber)
      if (index >= 0) current.fibers.splice(index, 1)
    }
    // Unload has started; keep this inertia pending until the test releases it.
    const live = gate()
    live?.entered?.()
    return live?.hold
  })
}
