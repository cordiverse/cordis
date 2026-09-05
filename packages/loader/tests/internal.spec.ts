import { expect, describe, it, vi } from 'vitest'
import { Context } from 'cordis'
import { ModuleLoader, Loader } from '../src'

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

  it('EntryTree.import logs a diagnostic when internal is unavailable and falls back to native import', async () => {
    const debugCalls: string[] = []
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation((...args) => {
      debugCalls.push(args.map(String).join(' '))
    })

    try {
      const ctx = new Context()
      await ctx.plugin(Loader)
      const loader = ctx.loader as any
      loader.internal = undefined
      // 'cosmokit' is a runtime dep (packages/loader/src/config/tree.ts:2) and
      // its specifier does not start with '.', so it exercises the third branch
      // of `EntryTree.import` — the silent fallback to native `import(name)`.
      const exports = await ctx.loader.import('cosmokit')
      expect(exports, 'fallback to native import() must still resolve the module').toBeTruthy()

      const sawDiagnostic = debugCalls.some((m) => /cordis:loader.*internal/.test(m))
      expect(
        sawDiagnostic,
        `expected a "cordis:loader: internal unavailable" diagnostic, got: ${JSON.stringify(debugCalls)}`,
      ).toBe(true)
    } finally {
      debugSpy.mockRestore()
    }
  })

  it('EntryTree.import does NOT log a diagnostic when internal is available', async () => {
    const debugCalls: string[] = []
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation((...args) => {
      debugCalls.push(args.map(String).join(' '))
    })

    try {
      const ctx = new Context()
      await ctx.plugin(Loader)
      // With internal present, the first branch (internal.import) runs and the
      // fallback diagnostic must not fire. cosmokit is a non-relative specifier.
      const exports = await ctx.loader.import('cosmokit')
      expect(exports).toBeTruthy()

      const sawDiagnostic = debugCalls.some((m) => /cordis:loader.*internal/.test(m))
      expect(sawDiagnostic, 'fallback diagnostic should not fire when internal is available').toBe(false)
    } finally {
      debugSpy.mockRestore()
    }
  })
})
