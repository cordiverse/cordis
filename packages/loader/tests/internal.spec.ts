import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, describe, it } from 'vitest'
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

describe('ModuleLoader.getInternalDiagnostics', () => {
  it('reports no diagnostics while internals are reachable', () => {
    // vitest runs with --expose-internals (vitest.config.ts), so the probe
    // succeeds and there is nothing to report
    expect(ModuleLoader.getInternalDiagnostics()).to.be.undefined
  })

  it('reports the failure reason without --expose-internals', function (ctx) {
    // a real consumer runs without --expose-internals; if the optional
    // node-addon-require-builtin is absent, the diagnostics must name it
    const loaderRoot = fileURLToPath(new URL('..', import.meta.url))
    let stdout: string
    try {
      stdout = execSync('node --import tsx --input-type=module', {
        cwd: loaderRoot,
        input: `
          import { ModuleLoader } from './src/internal.ts'
          const reason = ModuleLoader.getInternalDiagnostics()
          console.log(JSON.stringify({ internal: !!ModuleLoader.fromInternal(), reason }))
        `,
        encoding: 'utf-8',
      })
    } catch (error: any) {
      // some restricted environments cannot spawn children at all; verify
      // this end to end in a normal shell instead
      if (error.code === 'ENOENT') return ctx.skip()
      throw error
    }
    const match = stdout.match(/\{"internal":.*\}/)
    expect(match, stdout).to.be.ok
    const report = JSON.parse(match![0])
    // in the default consumer environment the addon is absent, so the
    // reason must name the dependency that is missing
    if (!report.internal) {
      expect(report.reason).to.include('node-addon-require-builtin')
    } else {
      expect(report.reason).to.be.undefined
    }
  })

  it('accepts --expose_internals with underscore spelling', function (ctx) {
    const loaderRoot = fileURLToPath(new URL('..', import.meta.url))
    let stdout: string
    try {
      stdout = execSync('node --expose_internals --import tsx --input-type=module', {
        cwd: loaderRoot,
        input: `
          import { ModuleLoader } from './src/internal.ts'
          const loader = ModuleLoader.fromInternal()
          console.log(JSON.stringify({ ok: !!loader, reason: ModuleLoader.getInternalDiagnostics() }))
        `,
        encoding: 'utf-8',
      })
    } catch (error: any) {
      if (error.code === 'ENOENT') return ctx.skip()
      throw error
    }
    const match = stdout.match(/\{"ok":.*\}/)
    expect(match, stdout).to.be.ok
    const report = JSON.parse(match![0])
    expect(report.ok).to.be.true
    expect(report.reason).to.be.undefined
  })
})
