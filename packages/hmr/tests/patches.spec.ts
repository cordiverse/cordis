import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { activate, invalidateResolution, ModuleCaches, ModuleLoader, requireInternal } from '../src/runtime/index.ts'
import { realpathESM, useFixtures } from './utils.ts'

const loader = ModuleLoader.fromInternal()!
const modules = new ModuleCaches(loader)
const importModule = (specifier: string, parentURL: string) => loader.import(specifier, parentURL, {})
activate()
const fixtures = useFixtures('manifests')
const { fixture, runESM } = fixtures
const require = createRequire(import.meta.url)

const url = (path: string) => pathToFileURL(path).href

/** `<name>/node_modules/baz` with `<field>: './a.<ext>'`, and the files `a` and `b` of versions 1 and 2. */
function baz(name: string, ext: string, field: 'main' | 'exports') {
  const dir = join(fixtures.dir, name, 'node_modules/baz')
  const manifest = (file: string) => JSON.stringify({ name: 'baz', [field]: `./${file}.${ext}` })
  fixture(`${name}/node_modules/baz/package.json`, manifest('a'))
  const exporter = (version: number) => ext === 'cjs' ? `exports.version = ${version}` : `export const version = ${version}`
  fixture(`${name}/node_modules/baz/a.${ext}`, exporter(1))
  fixture(`${name}/node_modules/baz/b.${ext}`, exporter(2))
  return {
    dir,
    manifest: join(dir, 'package.json'),
    old: url(join(dir, `a.${ext}`)),
    update: () => writeFileSync(join(dir, 'package.json'), manifest('b')),
  }
}

describe('manifests', () => {
  it('reads an invalidated manifest as Node does', () => {
    const reader = requireInternal('internal/modules/package_json_reader')
    const cases: (string | Buffer)[] = [
      '{"name":"a","main":"x.js","type":"module","exports":{".":"./a.js"},"imports":{"#a":"./b.js"}}',
      '\uFEFF{"type":"commonjs"}',
      '{"main":1,"type":"other","exports":null,"imports":3}',
      '{"exports":"./a.js","imports":["./b.js"]}',
      '{"main":"\\ud800"}',
      '{"name":1}',
      '{"type":true}',
      '{"name":"\\ud800"}',
      '[]',
      '{',
      '',
      Buffer.from([0x7B, 0xFF, 0x7D]),
    ]
    const read = (path: string) => {
      try {
        const { pjsonPath, ...result } = reader.read(path)
        return { result }
      } catch (error: any) {
        return { error: error.code }
      }
    }
    for (const [index, content] of cases.entries()) {
      const native = fixture(`parse/native/${index}/package.json`, '')
      const overlay = fixture(`parse/overlay/${index}/package.json`, '')
      writeFileSync(native, content)
      writeFileSync(overlay, content)
      invalidateResolution([join(fixtures.dir, 'parse/overlay')])
      expect(read(overlay), String(content)).to.deep.equal(read(native))
    }
  })

  it('resolves a CommonJS require after `main` is updated in place', () => {
    const { dir, old, update } = baz('cjs-main', 'cjs', 'main')
    const path = fixture('cjs-main/index.cjs', `module.exports = require('baz')`)
    expect(require(path)).to.have.property('version', 1)
    update()
    modules.evict([url(path), old])
    invalidateResolution([dir])
    expect(require(path)).to.have.property('version', 2)
  })

  it('resolves a later CommonJS require after a change confined to the manifest', () => {
    const { manifest, update } = baz('cjs-lazy', 'cjs', 'main')
    const path = fixture('cjs-lazy/lazy.cjs', `module.exports = () => require('baz').version`)
    const lazy = require(path)
    expect(lazy()).to.equal(1)
    update()
    invalidateResolution([manifest])
    expect(lazy()).to.equal(2)
  })

  it('resolves a later CommonJS require to a package added below the importer', () => {
    fixture('cjs-shadow/node_modules/qux/package.json', '{"name":"qux"}')
    fixture('cjs-shadow/node_modules/qux/index.js', 'exports.version = 1')
    fixture('cjs-shadow/app/node_modules/other/index.js', '')
    const path = fixture('cjs-shadow/app/lazy.cjs', `module.exports = () => require('qux').version`)
    const lazy = require(path)
    expect(lazy()).to.equal(1)
    fixture('cjs-shadow/app/node_modules/qux/package.json', '{"name":"qux","main":"main.cjs"}')
    fixture('cjs-shadow/app/node_modules/qux/main.cjs', 'exports.version = 2')
    invalidateResolution([join(fixtures.dir, 'cjs-shadow/app/node_modules/qux')])
    expect(lazy()).to.equal(2)
  })

  it('resolves a CommonJS require through a retargeted link whose manifest differs', () => {
    for (const version of [1, 2]) {
      fixture(`cjs-link/store/bar@${version}/package.json`, `{"name":"bar","main":"v${version}.cjs"}`)
      fixture(`cjs-link/store/bar@${version}/v${version}.cjs`, `exports.version = ${version}`)
    }
    const location = join(fixtures.dir, 'cjs-link/node_modules/bar')
    const previous = join(fixtures.dir, 'cjs-link/store/bar@1')
    mkdirSync(dirname(location), { recursive: true })
    symlinkSync(previous, location, 'junction')
    const path = fixture('cjs-link/index.cjs', `module.exports = require('bar')`)
    expect(require(path)).to.have.property('version', 1)
    unlinkSync(location)
    symlinkSync(join(fixtures.dir, 'cjs-link/store/bar@2'), location, 'junction')
    modules.evict([url(path), url(join(previous, 'v1.cjs'))])
    invalidateResolution([previous, location])
    expect(require(path)).to.have.property('version', 2)
  })

  it('resolves an ESM import after `exports` is updated in place', async () => {
    const { dir, manifest, old } = baz('esm-exports', 'mjs', 'exports')
    const path = fixture('esm-exports/index.mjs', `export { version } from 'baz'`)
    expect(await importModule(url(path), import.meta.url)).to.have.property('version', 1)
    writeFileSync(manifest, JSON.stringify({ name: 'baz', exports: './b.mjs' }))
    modules.evict([url(path), old])
    invalidateResolution([dir])
    expect(await importModule(url(path), import.meta.url)).to.have.property('version', 2)
  })

  it('imports a module in the format of a `type` updated in place', async () => {
    const dir = join(fixtures.dir, 'esm-type/node_modules/baz')
    fixture('esm-type/node_modules/baz/package.json', '{"name":"baz","type":"commonjs","main":"index.js"}')
    const index = fixture('esm-type/node_modules/baz/index.js', 'exports.version = 1')
    const path = fixture('esm-type/index.mjs', `import baz from 'baz'\nexport const version = baz.version`)
    expect(await importModule(url(path), import.meta.url)).to.have.property('version', 1)
    writeFileSync(join(dir, 'package.json'), '{"name":"baz","type":"module","main":"index.js"}')
    writeFileSync(index, 'export default { version: 2 }')
    modules.evict([url(path), url(index)])
    invalidateResolution([dir])
    expect(await importModule(url(path), import.meta.url)).to.have.property('version', 2)
  })

  it.runIf(realpathESM)('resolves an ESM import through a retargeted link whose manifest differs', async () => {
    for (const version of [1, 2]) {
      fixture(`esm-link/store/bar@${version}/package.json`, `{"name":"bar","exports":"./v${version}.mjs"}`)
      fixture(`esm-link/store/bar@${version}/v${version}.mjs`, `export const version = ${version}`)
    }
    const location = join(fixtures.dir, 'esm-link/node_modules/bar')
    const previous = join(fixtures.dir, 'esm-link/store/bar@1')
    mkdirSync(dirname(location), { recursive: true })
    symlinkSync(previous, location, 'junction')
    const path = fixture('esm-link/index.mjs', `export { version } from 'bar'`)
    expect(await importModule(url(path), import.meta.url)).to.have.property('version', 1)
    unlinkSync(location)
    symlinkSync(join(fixtures.dir, 'esm-link/store/bar@2'), location, 'junction')
    modules.evict([url(path), url(join(previous, 'v1.mjs'))])
    invalidateResolution([previous, location])
    expect(await importModule(url(path), import.meta.url)).to.have.property('version', 2)
  })

  it.runIf(typeof registerHooks === 'function')('requires a request that only a synchronous hook resolves', () => {
    const target = fixture('hook/target.cjs', 'exports.version = 1')
    const path = fixture('hook/index.cjs', `
      exports.file = require('virtual:file').version
      exports.source = require('virtual:source').version
    `)
    expect(runESM('hook', `
      const { createRequire, registerHooks } = await import('node:module')
      registerHooks({
        resolve: (specifier, context, nextResolve) => specifier === 'virtual:file'
          ? { url: ${JSON.stringify(url(target))}, shortCircuit: true }
          : specifier === 'virtual:source'
            ? { url: specifier, shortCircuit: true }
            : nextResolve(specifier, context),
        load: (url, context, nextLoad) => url === 'virtual:source'
          ? { format: 'commonjs', source: 'exports.version = 2', shortCircuit: true }
          : nextLoad(url, context),
      })
      invalidateResolution([${JSON.stringify(join(fixtures.dir, 'hook'))}])
      return createRequire(import.meta.url)(${JSON.stringify(path)})
    `)).to.deep.equal({ file: 1, source: 2 })
  })

  it.runIf(typeof registerHooks === 'function')('loads a hook-resolved file as the hook reports it, once replaced', () => {
    // CommonJS syntax in an ESM package, which only the `format` of the hook makes loadable
    fixture('hook-result/pkg/package.json', '{"type":"module"}')
    const target = fixture('hook-result/pkg/target.js', 'exports.version = 1')
    const absent = join(fixtures.dir, 'hook-result/pkg/absent.js')
    const path = fixture('hook-result/index.cjs', `
      exports.format = require('virtual:format').version
      exports.absent = require('virtual:absent').version
    `)
    expect(runESM('hook-result', `
      const { createRequire, registerHooks } = await import('node:module')
      registerHooks({
        resolve: (specifier, context, nextResolve) => specifier === 'virtual:format'
          ? { url: ${JSON.stringify(url(target))}, format: 'commonjs', shortCircuit: true }
          : specifier === 'virtual:absent'
            ? { url: ${JSON.stringify(url(absent))}, format: 'commonjs', shortCircuit: true }
            : nextResolve(specifier, context),
        load: (url, context, nextLoad) => url === ${JSON.stringify(url(absent))}
          ? { format: 'commonjs', source: 'exports.version = 2', shortCircuit: true }
          : nextLoad(url, context),
      })
      const require = createRequire(import.meta.url)
      const before = require(${JSON.stringify(path)})
      modules.evict([${JSON.stringify(url(path))}, ${JSON.stringify(url(target))}, ${JSON.stringify(url(absent))}])
      invalidateResolution([${JSON.stringify(join(fixtures.dir, 'hook-result'))}])
      const after = require(${JSON.stringify(path)})
      return { before, after }
    `)).to.deep.equal({ before: { format: 1, absent: 2 }, after: { format: 1, absent: 2 } })
  })

  it.runIf(typeof registerHooks === 'function')('resolves a later require to the builtin that a hook newly reports', () => {
    const requests = ['virtual:alias', 'path', 'node:path']
    // a file for each request, since Node records a request only when it loads the file
    const targets = Object.fromEntries(requests.map((request, index) => {
      return [request, url(fixture(`hook-builtin/target-${index}.cjs`, 'exports.version = 42'))]
    }))
    const path = fixture('hook-builtin/lazy.cjs', `module.exports = request => require(request)`)
    // the first requires precede the installation, so that Node records them under the requests
    const result = runESM('hook-builtin', `
      const { createRequire, registerHooks } = await import('node:module')
      const targets = ${JSON.stringify(targets)}
      let redirect = true
      registerHooks({
        resolve: (specifier, context, nextResolve) => redirect && specifier in targets
          ? { url: targets[specifier], shortCircuit: true }
          : specifier === 'virtual:alias'
            ? { url: 'node:path', shortCircuit: true }
            : nextResolve(specifier, context),
      })
      const lazy = createRequire(import.meta.url)(${JSON.stringify(path)})
      // where the native \`_load\` takes a \`node:\` request for a builtin whatever a hook resolves it to, the require fails
      const recorded = Object.keys(targets).filter(request => {
        try {
          return lazy(request).version === 42
        } catch {}
      })
      redirect = false
      activate()
      invalidateResolution([${JSON.stringify(join(fixtures.dir, 'hook-builtin'))}])
      const { default: builtin } = await import('node:path')
      return { recorded, after: recorded.map(request => lazy(request) === builtin) }
    `, { activate: false })
    expect(result.recorded).to.include.members(['virtual:alias', 'path'])
    expect(result.after.every(Boolean)).to.be.true
  })

  // `node:test` can only be required with the scheme
  it.runIf(typeof registerHooks === 'function').each(['node:path', 'node:test'])('loads a module that a load hook substitutes for `%s` as a child, once', (builtin) => {
    const name = builtin.slice(5)
    const path = fixture(`hook-substitute-${name}/lazy.cjs`, `module.exports = () => require(${JSON.stringify(builtin)})`)
    expect(runESM(`hook-substitute-${name}`, `
      const { createRequire, registerHooks } = await import('node:module')
      registerHooks({
        load: (url, context, nextLoad) => url === ${JSON.stringify(builtin)}
          ? { format: 'commonjs', source: 'globalThis.evaluations = (globalThis.evaluations ?? 0) + 1; exports.parent = module.parent', shortCircuit: true }
          : nextLoad(url, context),
      })
      invalidateResolution([${JSON.stringify(join(fixtures.dir, `hook-substitute-${name}`))}])
      const require = createRequire(import.meta.url)
      const lazy = require(${JSON.stringify(path)})
      const [first, second] = [lazy(), lazy()]
      const module = require.cache[${JSON.stringify(path)}]
      return {
        evaluations: globalThis.evaluations,
        same: first === second,
        parent: first.parent === module,
        child: module.children.some(child => child.exports === first),
      }
    `)).to.deep.equal({ evaluations: 1, same: true, parent: true, child: true })
  })

  it('requires a `node:` builtin past a module cached under its name', () => {
    const path = fixture('builtin-cache/lazy.cjs', `module.exports = request => require(request)`)
    expect(runESM('builtin-cache', `
      const { createRequire } = await import('node:module')
      const { default: builtin } = await import('node:path')
      const require = createRequire(import.meta.url)
      const fake = {}
      require.cache.path = { exports: fake, loaded: true }
      invalidateResolution([${JSON.stringify(join(fixtures.dir, 'builtin-cache'))}])
      const lazy = require(${JSON.stringify(path)})
      return { prefixed: lazy('node:path') === builtin, bare: lazy('path') === fake }
    `)).to.deep.equal({ prefixed: true, bare: true })
  })

  it.runIf(typeof registerHooks === 'function')('resolves a later require of a file to itself once the redirecting hook is deregistered', () => {
    const target = fixture('hook-deregister/target.cjs', 'exports.version = 7')
    const mock = fixture('hook-deregister/mock.cjs', 'exports.version = 42')
    const path = fixture('hook-deregister/lazy.cjs', `module.exports = () => require(${JSON.stringify(target)}).version`)
    // the first require precedes the installation, so that Node records it under the request
    expect(runESM('hook-deregister', `
      const { createRequire, registerHooks } = await import('node:module')
      const hooks = registerHooks({
        resolve: (specifier, context, nextResolve) => specifier === ${JSON.stringify(target)}
          ? { url: ${JSON.stringify(url(mock))}, shortCircuit: true }
          : nextResolve(specifier, context),
      })
      const lazy = createRequire(import.meta.url)(${JSON.stringify(path)})
      const before = lazy()
      hooks.deregister()
      activate()
      invalidateResolution([${JSON.stringify(join(fixtures.dir, 'hook-deregister'))}])
      return { before, after: lazy() }
    `, { activate: false })).to.deep.equal({ before: 42, after: 7 })
  })

  it('throws from a later CommonJS require after `exports` is updated to exclude the request', () => {
    const { manifest } = baz('cjs-unexported', 'cjs', 'exports')
    const path = fixture('cjs-unexported/lazy.cjs', `module.exports = () => require('baz').version`)
    // the first require precedes the installation, so that Node records it under the request
    expect(runESM('cjs-unexported', `
      const { writeFileSync } = await import('node:fs')
      const { createRequire } = await import('node:module')
      const lazy = createRequire(import.meta.url)(${JSON.stringify(path)})
      const before = lazy()
      writeFileSync(${JSON.stringify(manifest)}, ${JSON.stringify(JSON.stringify({ name: 'baz', exports: { '.': null } }))})
      activate()
      invalidateResolution([${JSON.stringify(manifest)}])
      try {
        return { before, after: lazy() }
      } catch (error) {
        return { before, code: error.code }
      }
    `, { activate: false })).to.deep.equal({ before: 1, code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
  })

  it('keeps reading the manifests that a disposed HMR has invalidated', () => {
    const { manifest } = baz('takeover', 'cjs', 'main')
    const path = fixture('takeover/lazy.cjs', `module.exports = () => require('baz').version`)
    // the first require precedes the first invalidation, so that Node caches the manifest
    expect(runESM('takeover', `
      const { writeFileSync } = await import('node:fs')
      const { createRequire } = await import('node:module')
      const deactivate = activate()
      const lazy = createRequire(import.meta.url)(${JSON.stringify(path)})
      const before = lazy()
      writeFileSync(${JSON.stringify(manifest)}, ${JSON.stringify(JSON.stringify({ name: 'baz', main: './b.cjs' }))})
      invalidateResolution([${JSON.stringify(manifest)}])
      deactivate()
      activate()
      return { before, after: lazy() }
    `, { activate: false })).to.deep.equal({ before: 1, after: 2 })
  })

  it('refuses to take over replacements that another wrapper has covered', () => {
    expect(runESM('covered', `
      const { default: Module } = await import('node:module')
      const deactivate = activate()
      deactivate()
      const { _load } = Module
      Module._load = function (...args) { return _load.apply(this, args) }
      try {
        activate()
      } catch (error) {
        return error.message
      }
    `, { activate: false })).to.match(/restart/)
  })

  it('leaves Node unchanged when a replacement cannot be installed', () => {
    expect(runESM('rollback', `
      const { default: Module } = await import('node:module')
      const { internalBinding, requireInternal } = await import(${JSON.stringify(url(fixtures.bundle))})
      const binding = internalBinding('modules')
      const reader = requireInternal('internal/modules/package_json_reader')
      const methods = () => [binding.readPackageJSON, binding.getNearestParentPackageJSON, binding.getPackageScopeConfig, Module._load]
      const originals = methods()
      Object.defineProperty(reader, 'getNearestParentPackageJSON', { value: reader.getNearestParentPackageJSON, writable: false })
      activate()
      return methods().map((method, index) => method === originals[index])
    `, { activate: false })).to.deep.equal([true, true, true, true])
  })
})
