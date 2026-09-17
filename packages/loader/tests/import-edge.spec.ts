import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { Loader } from '../src/index.ts'

describe('Loader: import edge cases', () => {
  const baseUrl = new URL('./fixtures/', import.meta.url).href

  async function setup() {
    const root = new Context()
    root.baseUrl = baseUrl
    await root.plugin(Loader, { baseUrl })
    return root
  }

  // `composeError` may throw synchronously, so a `.catch()` on the call would
  // miss it; an async wrapper turns both a sync throw and a rejection into one
  // awaited error.
  async function caught(task: () => unknown) {
    try {
      await task()
    } catch (error) {
      return error as Error
    }
    throw new Error('expected the import to fail')
  }

  it('reports a missing name before any lookup', async () => {
    const root = await setup()
    const error = await caught(() => root.loader.import(undefined as any))
    expect(error.message).toBe('entry name is required')
  })

  it('reports an unknown builtin against the base url', async () => {
    const root = await setup()
    const error = await caught(() => root.loader.import('cordis:not-a-builtin'))
    expect(error.message).toContain('cannot resolve cordis:not-a-builtin from')
  })

  it('falls back to the root base url for a relative specifier without the internal loader', async () => {
    const root = await setup()
    const loader = root.loader as any
    const internal = loader.internal
    // force the branch that anchors a relative specifier with `new URL`
    loader.internal = undefined
    // a child context whose own base url is unset; accessing `child.loader`
    // associates the service with it, so the tree must fall back to its root
    const child = root.extend({ baseUrl: undefined })
    try {
      expect((child as any).baseUrl).to.be.undefined
      const error = await caught(() => (child as any).loader.import('./definitely-missing-xyz'))
      // without the fallback, `new URL('./x', undefined)` throws a bare TypeError
      expect(error.message).not.toContain('Invalid URL')
    } finally {
      loader.internal = internal
    }
  })
})
