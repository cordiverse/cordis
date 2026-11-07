import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getRuntime } from '../src/index.ts'

const runtime = getRuntime()!

let dir: string

function fixture(path: string, content: string) {
  path = join(dir, path)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

/** Install `foo` nested below `<name>` and hoisted; `<name>/index.<ext>` re-exports it. */
function install(name: string, ext: string, importer: string, exporter: (version: number) => string) {
  const pkg = JSON.stringify({ name: 'foo', main: `index.${ext}` })
  fixture('node_modules/foo/package.json', pkg)
  fixture(`node_modules/foo/index.${ext}`, exporter(2))
  fixture(`${name}/node_modules/foo/package.json`, pkg)
  fixture(`${name}/node_modules/foo/index.${ext}`, exporter(1))
  return {
    path: fixture(`${name}/index.${ext}`, importer),
    root: join(dir, name, 'node_modules/foo'),
  }
}

describe('ResolutionCaches', () => {
  beforeAll(() => {
    // resolved paths are real paths, e.g. /private/var on macOS
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'loader-utils-resolution-')))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // in a child process, since the test runner registers asynchronous hooks
  async function moveESM(name: string, preamble = '') {
    const { path, root } = install(name, 'mjs', `export { version } from 'foo'`, version => `export const version = ${version}`)
    const bundle = join(dir, 'loader-utils.mjs')
    await build({
      entryPoints: [resolve(fileURLToPath(import.meta.url), '../../src/index.ts')],
      outfile: bundle,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
    })
    const script = fixture(`${name}.mjs`, `
      import { rmSync } from 'node:fs'
      ${preamble}
      import { getRuntime } from ${JSON.stringify(pathToFileURL(bundle).href)}
      const url = ${JSON.stringify(pathToFileURL(path).href)}
      const root = ${JSON.stringify(root)}
      const runtime = getRuntime()
      const before = (await runtime.import(url, import.meta.url)).version
      runtime.modules.evict([url, ${JSON.stringify(pathToFileURL(join(root, 'index.mjs')).href)}])
      rmSync(root, { recursive: true })
      runtime.resolution.invalidate([root])
      const after = (await runtime.import(url, import.meta.url)).version
      console.log(JSON.stringify({ before, after }))
    `)
    const output = execFileSync(process.execPath, ['--expose-internals', script], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    })
    return JSON.parse(output)
  }

  it('resolves an ESM import to the hoisted copy after the nested one is removed', async () => {
    expect(await moveESM('esm')).to.deep.equal({ before: 1, after: 2 })
  })

  it.runIf(typeof registerHooks === 'function')('resolves an ESM import to the hoisted copy under a synchronous hook that short-circuits file URLs', async () => {
    const preamble = `import { registerHooks } from 'node:module'
    registerHooks({
      resolve: (specifier, context, nextResolve) => specifier.startsWith('file:')
        ? { url: specifier, shortCircuit: true }
        : nextResolve(specifier, context),
    })`
    expect(await moveESM('esm-hooks', preamble)).to.deep.equal({ before: 1, after: 2 })
  })

  it('resolves a CommonJS require to the hoisted copy after the nested one is removed', () => {
    const { path, root } = install('cjs', 'cjs', `module.exports = require('foo')`, version => `exports.version = ${version}`)
    const require = createRequire(import.meta.url)
    expect(require(path)).to.have.property('version', 1)
    runtime.modules.evict([pathToFileURL(path).href, pathToFileURL(join(root, 'index.cjs')).href])
    rmSync(root, { recursive: true })
    runtime.resolution.invalidate([root])
    expect(require(path)).to.have.property('version', 2)
  })
})
