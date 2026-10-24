import { Context } from 'cordis'
import Loader, { ModuleLoader } from '@cordisjs/plugin-loader'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import Hmr from '../src/index.ts'
import { ModuleCache } from '../src/cache.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(testDir, '__cache__')
const req = createRequire(import.meta.url)

function fixture(name: string, content: string) {
  const path = resolve(fixtureDir, name)
  writeFileSync(path, content)
  return path
}

describe('Hmr module cache', () => {
  let ctx: Context
  let fiber: any

  beforeAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
    mkdirSync(fixtureDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
  })

  async function setup() {
    ctx = new Context()
    fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    await ctx.plugin(Hmr)
    return ctx
  }

  async function load(name: string, content: string) {
    const path = fixture(name, content)
    const id = await ctx.loader.create({ name: `./__cache__/${name}` })
    await ctx.loader.store[id]!.innerFiber!.await().catch(() => {})
    return path
  }

  it('drops an evicted CJS module from its parents children', async () => {
    await setup()
    fixture('c1.cjs', `exports.value = 'a'\n`)
    fixture('q1.cjs', `const { value } = require('./c1.cjs')\n\nexports.value = value\n`)
    await load('m1.ts', `
import { value } from './c1.cjs'

export const name = 'm1'

export async function apply(ctx: any) {
  ctx.on('cache/m1' as any, () => value)
}
`)
    await load('n1.ts', `
import { value } from './q1.cjs'

export const name = 'n1'

export async function apply(ctx: any) {
  ctx.on('cache/n1' as any, () => value)
}
`)
    expect(ctx.bail('cache/m1' as any)).to.equal('a')
    expect(ctx.bail('cache/n1' as any)).to.equal('a')

    const cPath = resolve(fixtureDir, 'c1.cjs')
    const oldC = req.cache[cPath]
    expect(oldC).to.be.ok

    fixture('c1.cjs', `exports.value = 'b'\n`)
    const result = await ctx.hmr.reconcile({ files: [cPath] })

    // the direct importer and the one behind the CJS module both reload
    expect(result.replaced).to.have.length(2)
    expect(ctx.bail('cache/m1' as any)).to.equal('b')
    expect(ctx.bail('cache/n1' as any)).to.equal('b')
    // the old module is no longer reachable through any parent's children
    const holders = Object.keys(req.cache).filter(p => req.cache[p].children.includes(oldC))
    expect(holders).to.have.length(0)
  }, 30000)

  it('restores the children edges it cut when a transaction aborts', async () => {
    await setup()
    fixture('c2.cjs', `exports.value = 'a'\n`)
    fixture('q2.cjs', `const { value } = require('./c2.cjs')\n\nexports.value = value\n`)
    await load('m2.ts', `
import { value } from './q2.cjs'

export const name = 'm2'

export async function apply(ctx: any) {
  ctx.on('cache/m2' as any, () => value)
}
`)
    const qPath = resolve(fixtureDir, 'q2.cjs')
    const cPath = resolve(fixtureDir, 'c2.cjs')
    const oldQ = req.cache[qPath]
    const children = oldQ.children.slice()

    // break the module the plugin imports
    fixture('q2.cjs', `const { value } = require('./c2.cjs')\n(this is not valid (\n`)
    const result = await ctx.hmr.reconcile({ files: [qPath] })

    expect(result.aborted).to.be.ok
    expect(ctx.bail('cache/m2' as any)).to.equal('a')
    // the restored parent still holds the restored child
    expect(req.cache[qPath]).to.equal(oldQ)
    expect(oldQ.children).to.deep.equal(children)
  }, 30000)

  it('reloads a plugin when a module it only requires changes', async () => {
    await setup()
    fixture('c3.cjs', `exports.value = 'a'\n`)
    fixture('q3.cjs', `const { value } = require('./c3.cjs')\n\nexports.value = value\n`)
    await load('n3.ts', `
import { value } from './q3.cjs'

export const name = 'n3'

export async function apply(ctx: any) {
  ctx.on('cache/n3' as any, () => value)
}
`)
    expect(ctx.bail('cache/n3' as any)).to.equal('a')

    const cPath = resolve(fixtureDir, 'c3.cjs')
    // never imported through `import()`: the CJS cache is the only one that holds it
    expect(Map.prototype.has.call(ctx.hmr.internal!.loadCache, pathToFileURL(cPath).href)).to.equal(false)

    fixture('c3.cjs', `exports.value = 'b'\n`)
    const result = await ctx.hmr.reconcile({ files: [cPath] })
    expect(result.replaced).to.have.length(1)
    expect(ctx.bail('cache/n3' as any)).to.equal('b')
  }, 30000)

  it('covers a required module in a roots batch', async () => {
    await setup()
    fixture('c4.cjs', `exports.value = 'a'\n`)
    fixture('q4.cjs', `const { value } = require('./c4.cjs')\n\nexports.value = value\n`)
    await load('n4.ts', `
import { value } from './q4.cjs'

export const name = 'n4'

export async function apply(ctx: any) {
  ctx.on('cache/n4' as any, () => value)
}
`)
    // the first pass records the baseline
    const cold = await ctx.hmr.reconcile({ roots: [fixtureDir] })
    expect(cold.replaced).to.have.length(1)

    fixture('c4.cjs', `exports.value = 'b'\n`)
    const result = await ctx.hmr.reconcile({ roots: [fixtureDir] })
    expect(result.replaced).to.have.length(1)
    expect(ctx.bail('cache/n4' as any)).to.equal('b')
  }, 30000)

  it('treats a required framework module as a host', async () => {
    fixture('host-dep.cjs', `exports.value = 'a'\n`)
    const mainPath = fixture('host-main.cjs', `require('./host-dep.cjs')\n`)
    ctx = new Context()
    fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    // load the main entry the way the process would, so both caches hold it
    const internal = ModuleLoader.fromInternal()!
    await internal.import(pathToFileURL(mainPath).href, import.meta.url, {})
    const argv = process.argv[1]
    process.argv[1] = mainPath
    try {
      await ctx.plugin(Hmr)
    } finally {
      process.argv[1] = argv
    }

    const depUrl = pathToFileURL(resolve(fixtureDir, 'host-dep.cjs')).href
    expect([...ctx.hmr.hosts]).to.include(depUrl)

    fixture('host-dep.cjs', `exports.value = 'b'\n`)
    const result = await ctx.hmr.reconcile({ files: [resolve(fixtureDir, 'host-dep.cjs')] })
    expect(result.restartReason).to.be.ok
    expect(result.replaced).to.have.length(0)
  }, 30000)

  it('cuts and restores the children edges of the CJS cache', () => {
    fixture('c5.cjs', `exports.value = 'a'\n`)
    fixture('q5.cjs', `const { value } = require('./c5.cjs')\n\nexports.value = value\n`)
    const qPath = resolve(fixtureDir, 'q5.cjs')
    const cPath = resolve(fixtureDir, 'c5.cjs')
    req(qPath)
    const oldQ = req.cache[qPath]
    expect(oldQ).to.be.ok
    const children = oldQ.children.slice()

    // a bare loader stands in for the ESM side: this test drives the CJS cache
    const cache = new ModuleCache({ loadCache: new Map() } as any)
    cache.evict([pathToFileURL(cPath).href])
    expect(req.cache[cPath]).to.equal(undefined)
    expect(oldQ.children).to.have.length(0)

    cache.restore()
    expect(req.cache[cPath]).to.be.ok
    expect(oldQ.children).to.deep.equal(children)
  })

  it('applies a fix to a module that failed to import', async () => {
    await setup()
    const host = await load('host.ts', `
export const name = 'host'

export async function apply(ctx: any) {
  ctx.on('cache/host' as any, () => 'v1')
}
`)
    writeFileSync(host, `
import { value } from './dep.ts'

export const name = 'host'

export async function apply(ctx: any) {
  ctx.on('cache/host' as any, () => value)
}
`)
    const dep = fixture('dep.ts', `export const value = 'broken'\n(this is not valid (\n`)
    const broken = await ctx.hmr.reconcile({ files: [host, dep] })
    expect(broken.aborted).to.be.ok
    expect(ctx.bail('cache/host' as any)).to.equal('v1')

    // a module whose evaluation failed leaves no entry behind on the Node
    // versions the suite runs, so the fixed content is loaded on the next
    // import and no eviction of its own is needed
    fixture('dep.ts', `export const value = 'fixed'\n`)
    writeFileSync(host, `
import { value } from './dep.ts'

export const name = 'host'

export async function apply(ctx: any) {
  ctx.on('cache/host' as any, () => value)
  // touched
}
`)
    const fixed = await ctx.hmr.reconcile({ files: [host] })
    expect(fixed.replaced).to.have.length(1)
    expect(ctx.bail('cache/host' as any)).to.equal('fixed')
  }, 30000)
})
