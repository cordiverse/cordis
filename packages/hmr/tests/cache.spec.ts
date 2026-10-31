import { Context } from 'cordis'
import { ModuleLoader } from '@cordisjs/loader-utils'
import Loader from '@cordisjs/plugin-loader'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
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

  it('cuts the evicted module out of its parents children', () => {
    fixture('c1.cjs', `exports.value = 'a'\n`)
    fixture('q1.cjs', `const { value } = require('./c1.cjs')\n\nexports.value = value\n`)
    const qPath = resolve(fixtureDir, 'q1.cjs')
    const cPath = resolve(fixtureDir, 'c1.cjs')
    req(qPath)
    const q = req.cache[qPath]!
    const c = req.cache[cPath]!
    expect(q.children).to.include(c)

    // a bare loader stands in for the ESM side: this test drives the CJS cache
    const cache = new ModuleCache({ loadCache: new Map() } as any)
    cache.evict([pathToFileURL(cPath).href])

    expect(req.cache[cPath]).to.equal(undefined)
    expect(q.children).to.not.include(c)
    cache.restore([])
  })

  it('puts back only the edges of the modules whose unit aborted', () => {
    fixture('c2.cjs', `exports.value = 'a'\n`)
    fixture('d2.cjs', `exports.value = 'a'\n`)
    fixture('q2.cjs', [
      `const { value } = require('./c2.cjs')`,
      `const { value: other } = require('./d2.cjs')`,
      ``,
      `exports.value = value + other`,
      ``,
    ].join('\n'))
    const qPath = resolve(fixtureDir, 'q2.cjs')
    const cPath = resolve(fixtureDir, 'c2.cjs')
    const dPath = resolve(fixtureDir, 'd2.cjs')
    req(qPath)
    const q = req.cache[qPath]!
    const c = req.cache[cPath]!
    const d = req.cache[dPath]!
    expect(q.children).to.include(c).and.to.include(d)

    // `c2.cjs` belongs to a unit that aborts, `d2.cjs` to one that commits
    const cache = new ModuleCache({ loadCache: new Map() } as any)
    cache.evict([pathToFileURL(cPath).href, pathToFileURL(dPath).href])
    expect(q.children).to.have.length(0)

    cache.restore([pathToFileURL(cPath).href])
    expect(req.cache[cPath]).to.equal(c)
    expect(req.cache[dPath]).to.equal(undefined)
    // the restored edge is back, the committed one is not
    expect(q.children).to.include(c)
    expect(q.children).to.not.include(d)
    cache.restore([pathToFileURL(dPath).href])
    expect(q.children).to.include(c).and.to.include(d)
  })

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
    expect(result.settledFibers).to.have.length(1)
    expect(ctx.bail('cache/n3' as any)).to.equal('b')
  }, 30000)

  it('drops the old instance from the children of every parent', async () => {
    await setup()
    fixture('c4.cjs', `exports.value = 'a'\n`)
    fixture('q4.cjs', `const { value } = require('./c4.cjs')\n\nexports.value = value\n`)
    await load('m4.ts', `
import { value } from './c4.cjs'

export const name = 'm4'

export async function apply(ctx: any) {
  ctx.on('cache/m4' as any, () => value)
}
`)
    await load('n4.ts', `
import { value } from './q4.cjs'

export const name = 'n4'

export async function apply(ctx: any) {
  ctx.on('cache/n4' as any, () => value)
}
`)
    expect(ctx.bail('cache/m4' as any)).to.equal('a')
    expect(ctx.bail('cache/n4' as any)).to.equal('a')

    const cPath = resolve(fixtureDir, 'c4.cjs')
    const oldC = req.cache[cPath]
    expect(oldC).to.be.ok

    fixture('c4.cjs', `exports.value = 'b'\n`)
    // the direct importer and the one behind the CJS module both reload
    const result = await ctx.hmr.reconcile({ files: [cPath] })
    expect(result.settledFibers).to.have.length(2)
    expect(ctx.bail('cache/m4' as any)).to.equal('b')
    expect(ctx.bail('cache/n4' as any)).to.equal('b')
    // the old instance is no longer reachable through any parent's children
    const holders = Object.keys(req.cache).filter(path => req.cache[path]!.children.includes(oldC!))
    expect(holders).to.have.length(0)
  }, 30000)

  it('restores the children edges it cut when the transaction aborts', async () => {
    await setup()
    fixture('c5.cjs', `exports.value = 'a'\n`)
    fixture('q5.cjs', `const { value } = require('./c5.cjs')\n\nexports.value = value\n`)
    await load('n5.ts', `
import { value } from './q5.cjs'

export const name = 'n5'

export async function apply(ctx: any) {
  ctx.on('cache/n5' as any, () => value)
}
`)
    const qPath = resolve(fixtureDir, 'q5.cjs')
    const oldQ = req.cache[qPath]
    expect(oldQ).to.be.ok
    const children = oldQ!.children.slice()

    // break the module the plugin imports
    fixture('q5.cjs', `const { value } = require('./c5.cjs')\n(this is not valid (\n`)
    const result = await ctx.hmr.reconcile({ files: [qPath] })

    expect(result.importFailures).to.have.length(1)
    expect(ctx.bail('cache/n5' as any)).to.equal('a')
    // the restored parent still holds the restored child
    expect(req.cache[qPath]).to.equal(oldQ)
    expect(oldQ!.children).to.deep.equal(children)
  }, 30000)

  it('keeps the first snapshot when a transaction evicts in two batches', () => {
    fixture('c7.cjs', `exports.value = 'a'\n`)
    fixture('d7.cjs', `exports.value = 'a'\n`)
    fixture('q7.cjs', [
      `const { value } = require('./c7.cjs')`,
      `const { value: other } = require('./d7.cjs')`,
      ``,
      `exports.value = value + other`,
      ``,
    ].join('\n'))
    const qPath = resolve(fixtureDir, 'q7.cjs')
    const cPath = resolve(fixtureDir, 'c7.cjs')
    const dPath = resolve(fixtureDir, 'd7.cjs')
    req(qPath)
    const q = req.cache[qPath]!
    const c = req.cache[cPath]!
    const d = req.cache[dPath]!

    // two batches: the second finds the array already cut, and must not
    // record the cut array as the state to restore
    const cache = new ModuleCache({ loadCache: new Map() } as any)
    cache.evict([pathToFileURL(cPath).href])
    cache.evict([pathToFileURL(dPath).href])
    expect(q.children).to.have.length(0)

    cache.restore([pathToFileURL(cPath).href, pathToFileURL(dPath).href])
    expect(q.children).to.include(c).and.to.include(d)
  })

  it('keeps a child a parent gained while the transaction ran', () => {
    fixture('c8.cjs', `exports.value = 'a'\n`)
    fixture('n8.cjs', `exports.value = 'n'\n`)
    fixture('q8.cjs', `const { value } = require('./c8.cjs')\n\nexports.value = value\n`)
    const qPath = resolve(fixtureDir, 'q8.cjs')
    const cPath = resolve(fixtureDir, 'c8.cjs')
    const nPath = resolve(fixtureDir, 'n8.cjs')
    req(qPath)
    req(nPath)
    const q = req.cache[qPath]!
    const c = req.cache[cPath]!
    const n = req.cache[nPath]!

    const cache = new ModuleCache({ loadCache: new Map() } as any)
    cache.evict([pathToFileURL(cPath).href])
    expect(q.children).to.not.include(c)

    // stage 1 imports something new that this parent also requires
    q.children.push(n)

    cache.restore([pathToFileURL(cPath).href])
    // the restored edge is back, and the one added meanwhile is untouched
    expect(q.children).to.include(c).and.to.include(n)
  })

  it('covers a required module in a roots batch', async () => {
    await setup()
    fixture('c6.cjs', `exports.value = 'a'\n`)
    fixture('q6.cjs', `const { value } = require('./c6.cjs')\n\nexports.value = value\n`)
    await load('n6.ts', `
import { value } from './q6.cjs'

export const name = 'n6'

export async function apply(ctx: any) {
  ctx.on('cache/n6' as any, () => value)
}
`)
    // the first pass records the baseline
    const cold = await ctx.hmr.reconcile({ roots: [fixtureDir] })
    expect(cold.settledFibers).to.have.length(1)

    fixture('c6.cjs', `exports.value = 'b'\n`)
    const result = await ctx.hmr.reconcile({ roots: [fixtureDir] })
    expect(result.settledFibers).to.have.length(1)
    expect(ctx.bail('cache/n6' as any)).to.equal('b')
  }, 30000)

  it('picks up a moved entry of an updated package', async () => {
    await setup()
    const pkgDir = resolve(fixtureDir, 'node_modules', 'mpkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'mpkg', main: './a.js' }))
    writeFileSync(join(pkgDir, 'a.js'), `exports.value = 'a'\n`)
    writeFileSync(join(pkgDir, 'b.js'), `exports.value = 'b'\n`)
    await load('mp.ts', `
import { value } from 'mpkg'

export const name = 'mp'

export async function apply(ctx: any) {
  ctx.on('cache/mp' as any, () => value)
}
`)
    expect(ctx.bail('cache/mp' as any)).to.equal('a')

    // the update moves the entry to b.js and rewrites the old one
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'mpkg', main: './b.js' }))
    writeFileSync(join(pkgDir, 'a.js'), `exports.value = 'a2'\n`)
    const result = await ctx.hmr.reconcile({ roots: [pkgDir] })

    expect(result.settledFibers).to.have.length(1)
    expect(ctx.bail('cache/mp' as any)).to.equal('b')
  }, 30000)
})
