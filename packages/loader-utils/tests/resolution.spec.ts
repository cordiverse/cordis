import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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

/**
 * Link `<name>/node_modules/bar` to `bar@1`, which stays installed beside
 * `bar@2`, as in an isolated layout where another importer keeps `bar@1`.
 * `<name>/index.<ext>` re-exports it.
 */
function link(name: string, ext: string, importer: string, exporter: (version: number) => string) {
  const pkg = JSON.stringify({ name: 'bar', main: `index.${ext}` })
  for (const version of [1, 2]) {
    fixture(`${name}/store/bar@${version}/package.json`, pkg)
    fixture(`${name}/store/bar@${version}/index.${ext}`, exporter(version))
  }
  const location = join(dir, name, 'node_modules/bar')
  const previous = join(dir, name, 'store/bar@1')
  mkdirSync(dirname(location), { recursive: true })
  symlinkSync(previous, location, 'junction')
  return {
    path: fixture(`${name}/index.${ext}`, importer),
    location,
    previous,
    next: join(dir, name, 'store/bar@2'),
  }
}

/** Node 24.16+ and 26.1+ pass the ESM realpath cache to `fs.realpathSync`. */
const realpathESM = (() => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 26 || major === 26 && minor >= 1 || major === 24 && minor >= 16
})()

describe('ResolutionCaches', () => {
  let bundle: string

  beforeAll(async () => {
    // resolved paths are real paths, e.g. /private/var on macOS
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'loader-utils-resolution-')))
    bundle = join(dir, 'loader-utils.mjs')
    await build({
      entryPoints: [resolve(fileURLToPath(import.meta.url), '../../src/index.ts')],
      outfile: bundle,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
    })
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Run `body` as an ES module in a child process, since the test runner
   * registers asynchronous hooks. `runtime` is in scope; the result of
   * `body` is printed and returned.
   */
  function runESM(name: string, body: string, preamble = '', library = bundle) {
    const script = fixture(`${name}.mjs`, `
      import { rmSync } from 'node:fs'
      ${preamble}
      import { getRuntime } from ${JSON.stringify(pathToFileURL(library).href)}
      const runtime = getRuntime()
      console.log(JSON.stringify(await (async () => { ${body} })()))
    `)
    const output = execFileSync(process.execPath, ['--expose-internals', script], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    })
    return JSON.parse(output)
  }

  function moveESM(name: string, preamble = '') {
    const { path, root } = install(name, 'mjs', `export { version } from 'foo'`, version => `export const version = ${version}`)
    return runESM(name, `
      const url = ${JSON.stringify(pathToFileURL(path).href)}
      const root = ${JSON.stringify(root)}
      const before = (await runtime.import(url, import.meta.url)).version
      runtime.modules.evict([url, ${JSON.stringify(pathToFileURL(join(root, 'index.mjs')).href)}])
      rmSync(root, { recursive: true })
      runtime.resolution.invalidate([root])
      const after = (await runtime.import(url, import.meta.url)).version
      return { before, after }
    `, preamble)
  }

  const shortCircuit = `import { registerHooks } from 'node:module'
    registerHooks({
      resolve: (specifier, context, nextResolve) => specifier.startsWith('file:')
        ? { url: specifier, shortCircuit: true }
        : nextResolve(specifier, context),
    })`

  it('resolves an ESM import to the hoisted copy after the nested one is removed', () => {
    expect(moveESM('esm')).to.deep.equal({ before: 1, after: 2 })
  })

  it.runIf(typeof registerHooks === 'function')('resolves an ESM import to the hoisted copy under a synchronous hook that short-circuits file URLs', () => {
    expect(moveESM('esm-hooks', shortCircuit)).to.deep.equal({ before: 1, after: 2 })
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

  it('reports realpath support where Node passes the ESM realpath cache to fs.realpathSync', () => {
    expect(runESM('support', 'return runtime.resolution.support')).to.deep.equal({ realpath: realpathESM })
  })

  it.runIf(typeof registerHooks === 'function')('reports realpath support under a synchronous hook that short-circuits file URLs', () => {
    expect(runESM('support-hooks', 'return runtime.resolution.support', shortCircuit)).to.deep.equal({ realpath: realpathESM })
  })

  it.runIf(realpathESM)('resolves an ESM import through a link that is retargeted', () => {
    const { path, location, previous, next } = link('esm-link', 'mjs', `export { version } from 'bar'`, version => `export const version = ${version}`)
    expect(runESM('esm-link', `
      const { symlinkSync, unlinkSync } = await import('node:fs')
      const url = ${JSON.stringify(pathToFileURL(path).href)}
      const before = (await runtime.import(url, import.meta.url)).version
      runtime.modules.evict([url, ${JSON.stringify(pathToFileURL(join(previous, 'index.mjs')).href)}])
      unlinkSync(${JSON.stringify(location)})
      symlinkSync(${JSON.stringify(next)}, ${JSON.stringify(location)}, 'junction')
      runtime.resolution.invalidate([${JSON.stringify(previous)}])
      const after = (await runtime.import(url, import.meta.url)).version
      return { before, after }
    `)).to.deep.equal({ before: 1, after: 2 })
  })

  it.runIf(realpathESM)('resolves an ESM import through a retargeted link after loader-utils itself is removed', () => {
    const { path, location, previous, next } = link('esm-removed', 'mjs', `export { version } from 'bar'`, version => `export const version = ${version}`)
    const library = join(dir, 'esm-removed/loader-utils.mjs')
    copyFileSync(bundle, library)
    expect(runESM('esm-removed', `
      const { symlinkSync, unlinkSync } = await import('node:fs')
      const url = ${JSON.stringify(pathToFileURL(path).href)}
      const before = (await runtime.import(url, import.meta.url)).version
      runtime.modules.evict([url, ${JSON.stringify(pathToFileURL(join(previous, 'index.mjs')).href)}])
      rmSync(${JSON.stringify(library)})
      unlinkSync(${JSON.stringify(location)})
      symlinkSync(${JSON.stringify(next)}, ${JSON.stringify(location)}, 'junction')
      runtime.resolution.invalidate([${JSON.stringify(previous)}])
      const after = (await runtime.import(url, import.meta.url)).version
      return { before, after }
    `, '', library)).to.deep.equal({ before: 1, after: 2 })
  })

  it('retries a probe that failed', () => {
    expect(runESM('support-retry', `
      const { default: Module } = await import('node:module')
      const { _findPath } = Module
      Module._findPath = () => { throw new Error('probe') }
      const failed = runtime.resolution.support
      Module._findPath = _findPath
      return { failed, retried: runtime.resolution.support }
    `)).to.deep.equal({ failed: { realpath: false }, retried: { realpath: realpathESM } })
  })

  it('resolves a CommonJS require through a retargeted link when the ESM probe fails', () => {
    const { path, location, previous, next } = link('cjs-esm-failed', 'cjs', `module.exports = require('bar')`, version => `exports.version = ${version}`)
    expect(runESM('cjs-esm-failed', `
      const { createRequire } = await import('node:module')
      const { symlinkSync, unlinkSync } = await import('node:fs')
      const require = createRequire(import.meta.url)
      const loader = require('internal/modules/esm/loader').getOrInitializeCascadedLoader()
      const path = ${JSON.stringify(path)}
      const before = require(path).version
      runtime.modules.evict([${JSON.stringify(pathToFileURL(path).href)}, ${JSON.stringify(pathToFileURL(join(previous, 'index.cjs')).href)}])
      unlinkSync(${JSON.stringify(location)})
      symlinkSync(${JSON.stringify(next)}, ${JSON.stringify(location)}, 'junction')
      loader.resolveSync = () => { throw new Error('probe') }
      try {
        runtime.resolution.invalidate([${JSON.stringify(previous)}])
      } finally {
        delete loader.resolveSync
      }
      return { before, after: require(path).version }
    `)).to.deep.equal({ before: 1, after: 2 })
  })

  it('resolves a CommonJS require through a link that is retargeted', () => {
    const { path, location, previous, next } = link('cjs-link', 'cjs', `module.exports = require('bar')`, version => `exports.version = ${version}`)
    const require = createRequire(import.meta.url)
    expect(require(path)).to.have.property('version', 1)
    runtime.modules.evict([pathToFileURL(path).href, pathToFileURL(join(previous, 'index.cjs')).href])
    unlinkSync(location)
    symlinkSync(next, location, 'junction')
    runtime.resolution.invalidate([previous])
    expect(require(path)).to.have.property('version', 2)
  })
})
