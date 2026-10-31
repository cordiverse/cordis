import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ModuleLoader } from '@cordisjs/loader-utils'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { invalidate, isInvalidated, read, resolveEntry } from '../src/manifest.ts'

const testDir = join(tmpdir(), 'cordis-manifest-spec')

function pkg(name: string) {
  const dir = join(testDir, name, 'node_modules', 'p')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(testDir, name, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }))
  return dir
}

function manifest(dir: string, content: object) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(content))
}

describe('manifest', () => {
  beforeAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('reads the manifest from disk, past any cache', () => {
    const dir = pkg('read')
    manifest(dir, { name: 'p', main: './a.js' })
    expect(read(dir)?.main).to.equal('./a.js')
    manifest(dir, { name: 'p', main: './b.js' })
    expect(read(dir)?.main).to.equal('./b.js')
  })

  it('resolves the entry through exports', () => {
    const dir = pkg('exports')
    manifest(dir, { name: 'p', exports: { '.': './src/index.js' } })
    expect(resolveEntry(dir, '.')).to.equal(join(dir, 'src/index.js'))
    manifest(dir, { name: 'p', exports: { './sub': './src/sub.js' } })
    expect(resolveEntry(dir, './sub')).to.equal(join(dir, 'src/sub.js'))
    // the condition follows the module system the import runs in
    manifest(dir, { name: 'p', exports: { '.': { import: './esm.js', require: './cjs.js' } } })
    expect(resolveEntry(dir, '.', 'module')).to.equal(join(dir, 'esm.js'))
    expect(resolveEntry(dir, '.', 'commonjs')).to.equal(join(dir, 'cjs.js'))
    // one wildcard per pattern
    manifest(dir, { name: 'p', exports: { './features/*': './src/features/*.js' } })
    expect(resolveEntry(dir, './features/x')).to.equal(join(dir, 'src/features/x.js'))
    // an array of candidates, the first match wins
    manifest(dir, { name: 'p', exports: [{ './miss': './miss.js' }, { './hit': './hit.js' }] })
    expect(resolveEntry(dir, './hit')).to.equal(join(dir, 'hit.js'))
    // a subpath the exports do not cover
    expect(resolveEntry(dir, './other')).to.equal(undefined)
  })

  it('falls back to main for the entry itself', () => {
    const dir = pkg('main')
    manifest(dir, { name: 'p', main: './entry.js' })
    expect(resolveEntry(dir, '.')).to.equal(join(dir, 'entry.js'))
    // main does not cover a subpath
    expect(resolveEntry(dir, './sub')).to.equal(undefined)
    // exports wins over main
    manifest(dir, { name: 'p', main: './entry.js', exports: { '.': './exported.js' } })
    expect(resolveEntry(dir, '.')).to.equal(join(dir, 'exported.js'))
  })

  it('ignores a directory without a manifest', () => {
    const dir = pkg('none')
    rmSync(join(dir, 'package.json'), { force: true })
    expect(read(dir)).to.equal(undefined)
    expect(resolveEntry(dir, '.')).to.equal(undefined)
    invalidate(pathToFileURL(dir).href)
    expect(isInvalidated(pathToFileURL(dir).href)).to.equal(false)
  })

  it('hands the loader the fresh entry of an invalidated package', async () => {
    const dir = pkg('hook')
    manifest(dir, { name: 'p', main: './a.js' })
    writeFileSync(join(dir, 'a.js'), 'module.exports = "A"\n')
    writeFileSync(join(dir, 'b.js'), 'module.exports = "B"\n')
    writeFileSync(join(testDir, 'hook', 'main.mjs'), `import v from 'p'\n\nexport default v\n`)
    const mainUrl = pathToFileURL(join(testDir, 'hook', 'main.mjs')).href
    const internal = ModuleLoader.fromInternal()!

    expect((await internal.import(mainUrl, import.meta.url, {})).default).to.equal('A')

    // the entry moves to b.js; until the package is invalidated the loader
    // keeps resolving the old one, which is the stale read being observed
    manifest(dir, { name: 'p', main: './b.js' })
    expect((await internal.import(`${mainUrl}?stale`, import.meta.url, {})).default).to.equal('A')

    invalidate(pathToFileURL(dir).href)
    expect(isInvalidated(pathToFileURL(dir).href)).to.equal(true)
    expect((await internal.import(`${mainUrl}?fresh`, import.meta.url, {})).default).to.equal('B')
  }, 30000)

  it('keeps the CJS answer stale until the package is invalidated', async () => {
    // the control: without an invalidation, a moved entry stays invisible to
    // `require` — this is the staleness the bypass exists for
    const dir = pkg('cjs-control')
    manifest(dir, { name: 'p', main: './a.js' })
    writeFileSync(join(dir, 'a.js'), 'module.exports = "A"\n')
    writeFileSync(join(dir, 'b.js'), 'module.exports = "B"\n')
    const consumer = join(testDir, 'cjs-control', 'q.cjs')
    writeFileSync(consumer, `module.exports = require('p')\n`)
    const req = createRequire(consumer)
    expect(req('p')).to.equal('A')

    manifest(dir, { name: 'p', main: './b.js' })
    // `require.cache` is keyed by the real path, so a module is evicted through
    // that path — a link in the way is why this matters
    delete req.cache[realpathSync(join(dir, 'a.js'))]
    delete req.cache[realpathSync(consumer)]
    expect(req('p')).to.equal('A')
  }, 30000)

  it('bypasses the CJS resolution of an invalidated package', async () => {
    // `require` resolves through the path cache and the same native reader, so
    // a moved entry has to be answered for on that side as well
    const dir = pkg('cjs')
    manifest(dir, { name: 'p', main: './a.js' })
    writeFileSync(join(dir, 'a.js'), 'module.exports = "A"\n')
    writeFileSync(join(dir, 'b.js'), 'module.exports = "B"\n')
    const consumer = join(testDir, 'cjs', 'q.cjs')
    writeFileSync(consumer, `module.exports = require('p')\n`)
    const req = createRequire(consumer)
    expect(req('p')).to.equal('A')

    manifest(dir, { name: 'p', main: './b.js' })
    invalidate(pathToFileURL(dir).href)
    // the reload evicts the modules; the resolution has to follow the manifest
    delete req.cache[realpathSync(join(dir, 'a.js'))]
    delete req.cache[realpathSync(consumer)]
    expect(req('p')).to.equal('B')
  }, 30000)

  it('bypasses a package the loader reports by its real path', async () => {
    // Node resolves the links on the way to a module and reports the real
    // path, so a package reached through a symlink is invalidated under the
    // name the loader uses, not the one the caller passed. macOS reaches its
    // temporary directory through `/var`, which is how this was found.
    const real = pkg('link')
    const alias = join(testDir, 'link-alias')
    // a junction needs no privilege on Windows; POSIX takes no type here
    symlinkSync(join(testDir, 'link'), alias, process.platform === 'win32' ? 'junction' : undefined)
    const linkedPkg = join(alias, 'node_modules', 'p')
    manifest(real, { name: 'p', main: './a.js' })
    writeFileSync(join(real, 'a.js'), 'module.exports = "A"\n')
    writeFileSync(join(real, 'b.js'), 'module.exports = "B"\n')
    writeFileSync(join(alias, 'main.mjs'), `import v from 'p'\n\nexport default v\n`)
    const mainUrl = pathToFileURL(join(alias, 'main.mjs')).href
    const internal = ModuleLoader.fromInternal()!

    // the module is loaded through the link, so the loader sees the real path
    expect((await internal.import(mainUrl, import.meta.url, {})).default).to.equal('A')

    manifest(real, { name: 'p', main: './b.js' })
    // invalidated under the linked name; the bypass has to answer for the
    // real one the loader reports
    invalidate(pathToFileURL(linkedPkg).href)
    expect(isInvalidated(pathToFileURL(linkedPkg).href)).to.equal(true)
    expect((await internal.import(`${mainUrl}?link`, import.meta.url, {})).default).to.equal('B')
  }, 30000)

  it('leaves the packages that were not invalidated alone', async () => {
    const dir = pkg('control')
    manifest(dir, { name: 'p', main: './a.js' })
    writeFileSync(join(dir, 'a.js'), 'module.exports = "A"\n')
    writeFileSync(join(dir, 'b.js'), 'module.exports = "B"\n')
    writeFileSync(join(testDir, 'control', 'main.mjs'), `import v from 'p'\n\nexport default v\n`)
    const mainUrl = pathToFileURL(join(testDir, 'control', 'main.mjs')).href
    const internal = ModuleLoader.fromInternal()!

    // the lookup is warm, so the staleness of the reader is what is observed
    expect((await internal.import(mainUrl, import.meta.url, {})).default).to.equal('A')
    manifest(dir, { name: 'p', main: './b.js' })
    // the hook is installed by the test above; this package was never
    // invalidated, so its lookups still go through Node
    expect((await internal.import(`${mainUrl}?control`, import.meta.url, {})).default).to.equal('A')
  }, 30000)

})
