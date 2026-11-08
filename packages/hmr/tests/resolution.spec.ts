import { copyFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { activate, getResolutionSupport, invalidateResolution, ModuleCaches, ModuleLoader } from '../src/runtime/index.ts'
import { realpathESM, useFixtures } from './utils.ts'

const loader = ModuleLoader.fromInternal()!
activate()
const modules = new ModuleCaches(loader)
const importModule = (specifier: string, parentURL: string) => loader.import(specifier, parentURL, {})
const fixtures = useFixtures('resolution')
const { fixture, runESM } = fixtures

/** Install `foo` nested below `<name>` and hoisted; `<name>/index.<ext>` re-exports it. */
function install(name: string, ext: string, importer: string, exporter: (version: number) => string) {
  const pkg = JSON.stringify({ name: 'foo', main: `index.${ext}` })
  fixture('node_modules/foo/package.json', pkg)
  fixture(`node_modules/foo/index.${ext}`, exporter(2))
  fixture(`${name}/node_modules/foo/package.json`, pkg)
  fixture(`${name}/node_modules/foo/index.${ext}`, exporter(1))
  return {
    path: fixture(`${name}/index.${ext}`, importer),
    root: join(fixtures.dir, name, 'node_modules/foo'),
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
  const location = join(fixtures.dir, name, 'node_modules/bar')
  const previous = join(fixtures.dir, name, 'store/bar@1')
  mkdirSync(dirname(location), { recursive: true })
  symlinkSync(previous, location, 'junction')
  return {
    path: fixture(`${name}/index.${ext}`, importer),
    location,
    previous,
    next: join(fixtures.dir, name, 'store/bar@2'),
  }
}

describe('ResolutionCaches', () => {
  async function moveESM(name: string) {
    const { path, root } = install(name, 'mjs', `export { version } from 'foo'`, version => `export const version = ${version}`)
    const url = pathToFileURL(path).href
    const before = (await importModule(url, import.meta.url)).version
    modules.evict([url, pathToFileURL(join(root, 'index.mjs')).href])
    rmSync(root, { recursive: true })
    invalidateResolution([root])
    const after = (await importModule(url, import.meta.url)).version
    return { before, after }
  }

  const shortCircuit = `import { registerHooks } from 'node:module'
    registerHooks({
      resolve: (specifier, context, nextResolve) => specifier.startsWith('file:')
        ? { url: specifier, shortCircuit: true }
        : nextResolve(specifier, context),
    })`

  it('resolves an ESM import to the hoisted copy after the nested one is removed', async () => {
    expect(await moveESM('esm')).to.deep.equal({ before: 1, after: 2 })
  })

  it.runIf(typeof registerHooks === 'function')('resolves an ESM import to the hoisted copy under a synchronous hook that short-circuits file URLs', async () => {
    const hooks = registerHooks({
      resolve: (specifier, context, nextResolve) => specifier.startsWith('file:')
        ? { url: specifier, shortCircuit: true }
        : nextResolve(specifier, context),
    })
    try {
      expect(await moveESM('esm-hooks')).to.deep.equal({ before: 1, after: 2 })
    } finally {
      hooks.deregister()
    }
  })

  it('resolves a later ESM import of a package import after only the manifest changes', async () => {
    // the targets lie outside the package, so that only the importer is below the root
    const manifest = (target: string) => JSON.stringify({ name: 'imports', type: 'module', imports: { '#dep': target } })
    for (const version of [1, 2]) {
      fixture(`node_modules/imports-${version}/package.json`, JSON.stringify({ name: `imports-${version}`, type: 'module', exports: './index.mjs' }))
      fixture(`node_modules/imports-${version}/index.mjs`, `export const version = ${version}`)
    }
    const path = fixture('imports/package.json', manifest('imports-1'))
    const lazy = fixture('imports/lazy.mjs', `export const load = () => import('#dep')`)
    const { load } = await importModule(pathToFileURL(lazy).href, import.meta.url)
    expect(await load()).to.have.property('version', 1)
    fixture('imports/package.json', manifest('imports-2'))
    invalidateResolution([path])
    expect(await load()).to.have.property('version', 2)
  })

  it('resolves a later ESM import to a package added below the importer', async () => {
    const pkg = JSON.stringify({ name: 'qux', type: 'module', exports: './index.mjs' })
    fixture('shadow/node_modules/qux/package.json', pkg)
    fixture('shadow/node_modules/qux/index.mjs', 'export const version = 1')
    const lazy = fixture('shadow/app/lazy.mjs', `export const load = () => import('qux')`)
    const { load } = await importModule(pathToFileURL(lazy).href, import.meta.url)
    expect(await load()).to.have.property('version', 1)
    fixture('shadow/app/node_modules/qux/package.json', pkg)
    fixture('shadow/app/node_modules/qux/index.mjs', 'export const version = 2')
    invalidateResolution([join(fixtures.dir, 'shadow/app/node_modules/qux')])
    expect(await load()).to.have.property('version', 2)
  })

  it('resolves a CommonJS require to the hoisted copy after the nested one is removed', () => {
    const { path, root } = install('cjs', 'cjs', `module.exports = require('foo')`, version => `exports.version = ${version}`)
    const require = createRequire(import.meta.url)
    expect(require(path)).to.have.property('version', 1)
    modules.evict([pathToFileURL(path).href, pathToFileURL(join(root, 'index.cjs')).href])
    rmSync(root, { recursive: true })
    invalidateResolution([root])
    expect(require(path)).to.have.property('version', 2)
  })

  it('reports realpath support where Node passes the ESM realpath cache to fs.realpathSync', () => {
    expect(runESM('support', 'return getResolutionSupport()')).to.deep.equal({ realpath: realpathESM })
  })

  it.runIf(typeof registerHooks === 'function')('reports realpath support under a synchronous hook that short-circuits file URLs', () => {
    expect(runESM('support-hooks', 'return getResolutionSupport()', { preamble: shortCircuit })).to.deep.equal({ realpath: realpathESM })
  })

  it.runIf(realpathESM)('resolves an ESM import through a link that is retargeted', async () => {
    const { path, location, previous, next } = link('esm-link', 'mjs', `export { version } from 'bar'`, version => `export const version = ${version}`)
    const url = pathToFileURL(path).href
    expect(await importModule(url, import.meta.url)).to.have.property('version', 1)
    modules.evict([url, pathToFileURL(join(previous, 'index.mjs')).href])
    unlinkSync(location)
    symlinkSync(next, location, 'junction')
    invalidateResolution([previous])
    expect(await importModule(url, import.meta.url)).to.have.property('version', 2)
  })

  it.runIf(realpathESM)('resolves an ESM import through a retargeted link after the runtime itself is removed', () => {
    const { path, location, previous, next } = link('esm-removed', 'mjs', `export { version } from 'bar'`, version => `export const version = ${version}`)
    const library = join(fixtures.dir, 'esm-removed/runtime.mjs')
    copyFileSync(fixtures.bundle, library)
    expect(runESM('esm-removed', `
      const { symlinkSync, unlinkSync } = await import('node:fs')
      const url = ${JSON.stringify(pathToFileURL(path).href)}
      const before = (await importModule(url, import.meta.url)).version
      modules.evict([url, ${JSON.stringify(pathToFileURL(join(previous, 'index.mjs')).href)}])
      rmSync(${JSON.stringify(library)})
      unlinkSync(${JSON.stringify(location)})
      symlinkSync(${JSON.stringify(next)}, ${JSON.stringify(location)}, 'junction')
      invalidateResolution([${JSON.stringify(previous)}])
      const after = (await importModule(url, import.meta.url)).version
      return { before, after }
    `, { library })).to.deep.equal({ before: 1, after: 2 })
  })

  it('retries a probe that failed', () => {
    expect(runESM('support-retry', `
      const { default: Module } = await import('node:module')
      const { _findPath } = Module
      Module._findPath = () => { throw new Error('probe') }
      const failed = getResolutionSupport()
      Module._findPath = _findPath
      return { failed, retried: getResolutionSupport() }
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
      modules.evict([${JSON.stringify(pathToFileURL(path).href)}, ${JSON.stringify(pathToFileURL(join(previous, 'index.cjs')).href)}])
      unlinkSync(${JSON.stringify(location)})
      symlinkSync(${JSON.stringify(next)}, ${JSON.stringify(location)}, 'junction')
      loader.resolveSync = () => { throw new Error('probe') }
      try {
        invalidateResolution([${JSON.stringify(previous)}])
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
    modules.evict([pathToFileURL(path).href, pathToFileURL(join(previous, 'index.cjs')).href])
    unlinkSync(location)
    symlinkSync(next, location, 'junction')
    invalidateResolution([previous])
    expect(require(path)).to.have.property('version', 2)
  })
})
