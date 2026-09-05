import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModuleLoader } from '../src'

describe('ModuleLoader.fromInternal', () => {
  it('tags the running loader with the resolver signature it accepts', () => {
    const loader = ModuleLoader.fromInternal()
    expect(loader, 'node module internals are unreachable; hmr partial reload needs them').to.be.ok
    // Resolving through the tag is exactly what `Hmr._resolve()` does. A tag
    // taken from the node major instead of the loader's own API rejects every
    // call on 24.0-24.11.1, which report major 24 while carrying the v1 loader.
    const resolved = loader!.version === 'v2'
      ? loader!.resolveSync(import.meta.url, { specifier: 'node:path', attributes: {} })
      : loader!.resolveSync('node:path', import.meta.url, {})
    expect(resolved.url).to.equal('node:path')
  })
})

// Regression coverage for the silent `catch {}` in requireInternal(): the
// fallback used to swallow errors, leaving callers with a misleading
// "--expose-internals is required" string. Now it logs a `cordis:loader:`
// debug line and still returns undefined, so HMR can degrade gracefully.
//
// vi.doMock keeps the mock scoped to the dynamic import below; the
// real-require test above is not affected.
describe('ModuleLoader.requireInternal diagnostics', () => {
  const originalExecArgv = process.execArgv
  const debugCalls: string[] = []

  beforeEach(() => {
    debugCalls.length = 0
    vi.resetModules()
    vi.spyOn(console, 'debug').mockImplementation((...args: any[]) => {
      debugCalls.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.execArgv = originalExecArgv
    vi.doUnmock('node:module')
    vi.resetModules()
  })

  it('logs a cordis:loader diagnostic and returns undefined when require fails', async () => {
    vi.doMock('node:module', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:module')>()
      return {
        ...actual,
        createRequire: () => () => {
          throw new Error('forced test failure: simulated missing module')
        },
      }
    })
    const { ModuleLoader: Fresh } = await import('../src')
    process.execArgv = []

    const result = Fresh.fromInternal()
    expect(result).toBeUndefined()
    const sawDiagnostic = debugCalls.some((m) => /cordis:loader/.test(m))
    expect(sawDiagnostic, `expected cordis:loader diagnostic; got ${JSON.stringify(debugCalls)}`).toBe(true)
  })
})
