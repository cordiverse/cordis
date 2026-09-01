import { execFileSync } from 'node:child_process'
import { expect, describe, it } from 'vitest'

describe('ModuleLoader.fromInternal', () => {
  it('classifies the Node 24.9 loader by its runtime shape', () => {
    const source = new URL('../src/internal.ts', import.meta.url).href
    const script = `
      import { createRequire } from 'node:module'
      const { ModuleLoader } = await import(${JSON.stringify(source)})
      const require = createRequire(import.meta.url)
      const internal = require('internal/modules/esm/loader')
      internal.getOrInitializeCascadedLoader = () => ({ getModuleJobForImport() {} })
      Object.defineProperty(process.versions, 'node', { value: '24.9.0' })
      console.log(ModuleLoader.fromInternal()?.version)
    `
    const output = execFileSync(process.execPath, [
      '--no-deprecation',
      '--expose-internals',
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script,
    ], { encoding: 'utf8' })
    expect(output.trim()).to.equal('v1')
  })
})
