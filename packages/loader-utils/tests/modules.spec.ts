import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getRuntime } from '../src/index.ts'

const runtime = getRuntime()!
const modules = runtime.modules

// Evaluations are counted on `globalThis`, which every instance of a module shares.
const counts: Record<string, number> = (globalThis as any).__loaderUtilsModules = {}

let dir: string

function fixture(name: string, content: string) {
  const path = join(dir, name)
  writeFileSync(path, content)
  return pathToFileURL(path).href
}

function counted(name: string, body = '') {
  return `globalThis.__loaderUtilsModules[${JSON.stringify(name)}] = (globalThis.__loaderUtilsModules[${JSON.stringify(name)}] ?? 0) + 1\n${body}`
}

describe('ModuleCaches', () => {
  beforeAll(() => {
    // module URLs are real paths, e.g. /private/var on macOS
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'loader-utils-modules-')))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists the modules of both caches', async () => {
    const esm = fixture('list.mjs', 'export const value = 1')
    const cjs = fixture('list.cjs', 'module.exports = 1')
    await runtime.import(esm, import.meta.url)
    createRequire(import.meta.url)(fileURLToPath(cjs))
    expect(modules.urls()).to.include(esm).and.include(cjs)
    expect(modules.has(esm)).to.be.true
    expect(modules.has(cjs)).to.be.true
    expect(modules.has(fixture('list-unloaded.mjs', ''))).to.be.false
  })

  it('reports static imports and CommonJS children as edges', async () => {
    const leaf = fixture('edges-leaf.mjs', 'export default 1')
    const child = fixture('edges-child.cjs', 'module.exports = 1')
    const parent = fixture('edges-parent.cjs', `require('./edges-child.cjs')`)
    const root = fixture('edges-root.mjs', `import './edges-leaf.mjs'\nimport './edges-parent.cjs'`)
    await runtime.import(root, import.meta.url)
    expect([...await modules.edges(root)]).to.have.members([leaf, parent])
    expect([...await modules.edges(parent)]).to.have.members([child])
  })

  it('reads the namespace of an evaluated module only', async () => {
    const ok = fixture('namespace-ok.mjs', 'export const value = 1')
    const broken = fixture('namespace-broken.mjs', 'export const value = 1\nthrow new Error("broken")')
    await runtime.import(ok, import.meta.url)
    await expect(runtime.import(broken, import.meta.url)).rejects.toThrow('broken')
    expect(modules.namespace(ok)).to.have.property('value', 1)
    expect(modules.namespace(broken)).to.be.undefined
    expect(modules.namespace(fixture('namespace-unloaded.mjs', ''))).to.be.undefined
  })

  it('evaluates an evicted module again on its next import', async () => {
    const url = fixture('evict.mjs', counted('evict', 'export const value = 1'))
    const cjs = fixture('evict.cjs', counted('evict.cjs', 'module.exports = 1'))
    await runtime.import(url, import.meta.url)
    await runtime.import(cjs, import.meta.url)
    modules.evict([url, cjs])
    expect(modules.has(url)).to.be.false
    expect(modules.has(cjs)).to.be.false
    await runtime.import(url, import.meta.url)
    await runtime.import(cjs, import.meta.url)
    expect(counts.evict).to.equal(2)
    expect(counts['evict.cjs']).to.equal(2)
  })

  it('restores the evicted instances', async () => {
    const url = fixture('restore.mjs', 'export const value = {}')
    const before = await runtime.import(url, import.meta.url)
    const backup = modules.evict([url])
    const replaced = await runtime.import(url, import.meta.url)
    expect(replaced.value).not.to.equal(before.value)
    backup.restore([url])
    expect((await runtime.import(url, import.meta.url)).value).to.equal(before.value)
  })

  it('removes a module on restore that was not loaded when evicted', async () => {
    const url = fixture('restore-unloaded.mjs', 'export const value = 1')
    const backup = modules.evict([url])
    await runtime.import(url, import.meta.url)
    backup.restore([url])
    expect(modules.has(url)).to.be.false
  })

  it('lets a module that failed to evaluate be imported again after a sweep', async () => {
    const url = fixture('sweep.mjs', 'throw new Error("broken")')
    await expect(runtime.import(url, import.meta.url)).rejects.toThrow('broken')
    fixture('sweep.mjs', 'export const value = 1')
    await modules.sweep()
    expect(await runtime.import(url, import.meta.url)).to.have.property('value', 1)
  })

  it('lets a module that failed to link be imported again after a sweep', async () => {
    const url = fixture('sweep-link.mjs', `import { missing } from './sweep-link-dep.mjs'\nexport const value = missing`)
    fixture('sweep-link-dep.mjs', 'export const other = 1')
    await expect(runtime.import(url, import.meta.url)).rejects.toThrow(SyntaxError)
    fixture('sweep-link.mjs', `import { other } from './sweep-link-dep.mjs'\nexport const value = other`)
    await modules.sweep()
    expect(await runtime.import(url, import.meta.url)).to.have.property('value', 1)
  })

  it('keeps the jobs that have not failed through a sweep', async () => {
    const url = fixture('sweep-kept.mjs', counted('sweep-kept'))
    await runtime.import(url, import.meta.url)
    await modules.sweep()
    await runtime.import(url, import.meta.url)
    expect(counts['sweep-kept']).to.equal(1)
  })
})
