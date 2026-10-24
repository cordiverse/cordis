import { Context, Fiber, FiberState } from 'cordis'
import Loader, { unwrapExports } from '@cordisjs/plugin-loader'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import Hmr from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(testDir, '__reconcile__')

// Counters must survive module reloads, so they live on `globalThis`.
const stats: any = (globalThis as any).__hmrReconcile = {}

function plugin(name: string, value: string, body = '') {
  return `
import { Context } from 'cordis'

const stats: any = (globalThis as any).__hmrReconcile

export const name = '${name}'

export async function apply(ctx: Context) {
  ctx.on('reconcile/${name}' as any, () => '${value}')
  ${body}
}
`
}

function fixture(name: string, content: string) {
  const path = resolve(fixtureDir, name)
  writeFileSync(path, content)
  return path
}

describe('Hmr.reconcile', () => {
  let ctx: Context
  let fiber: Fiber<Context> | undefined

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
    const id = await ctx.loader.create({ name: `./__reconcile__/${name}` })
    await ctx.loader.store[id]!.innerFiber!.await().catch(() => {})
    return path
  }

  it('replaces an entry plugin', async () => {
    await setup()
    const path = await load('entry.ts', plugin('entry', 'v1'))
    expect(ctx.bail('reconcile/entry' as any)).to.equal('v1')

    const reloaded: Hmr.Result[] = []
    ctx.on('hmr/reload', result => { reloaded.push(result) })
    writeFileSync(path, plugin('entry', 'v2'))
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.replaced).to.have.length(1)
    expect(result.failed).to.deep.equal([])
    expect(result.pending).to.deep.equal([])
    expect(result.aborted).to.be.undefined
    expect(result.restartReason).to.be.undefined
    expect(reloaded).to.deep.equal([result])
    expect(ctx.bail('reconcile/entry' as any)).to.equal('v2')
  })

  it('replaces the inner fiber of an entry with an injection scope', async () => {
    await setup()
    ctx.provide('reconcileScope', {})
    const path = fixture('scoped.ts', plugin('scoped', 'v1'))
    const id = await ctx.loader.create({ name: './__reconcile__/scoped.ts', inject: ['reconcileScope'] })
    const entry = ctx.loader.store[id]!
    await ctx.loader.await()
    const outer = entry.outerFiber!
    expect(outer).to.be.ok
    expect(ctx.bail('reconcile/scoped' as any)).to.equal('v1')

    writeFileSync(path, plugin('scoped', 'v2'))
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.replaced).to.have.length(1)
    // the outer fiber is kept, and the new fiber takes the place of the inner one
    expect(entry.outerFiber === outer).to.equal(true)
    expect(entry.innerFiber!.uid).to.equal(result.replaced[0].uid)
    expect(result.replaced[0].parent.fiber.uid).to.equal(outer.uid)
    expect(ctx.bail('reconcile/scoped' as any)).to.equal('v2')
  })

  it('accepts a file URL', async () => {
    await setup()
    const path = await load('url.ts', plugin('url', 'v1'))

    writeFileSync(path, plugin('url', 'v2'))
    const result = await ctx.hmr.reconcile({ files: [pathToFileURL(path)] })

    expect(result.replaced).to.have.length(1)
    expect(ctx.bail('reconcile/url' as any)).to.equal('v2')
  })

  it('replaces a plugin that no entry manages', async () => {
    await setup()
    const path = fixture('direct.ts', plugin('direct', 'v1'))
    const exports = await ctx.hmr.internal!.import(pathToFileURL(path).href, import.meta.url, {})
    await ctx.plugin(unwrapExports(exports))
    expect(ctx.bail('reconcile/direct' as any)).to.equal('v1')

    writeFileSync(path, plugin('direct', 'v2'))
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.replaced).to.have.length(1)
    expect(ctx.bail('reconcile/direct' as any)).to.equal('v2')
  })

  it('keeps the metadata of an entry that re-exports the changed plugin', async () => {
    await setup()
    ctx.provide('reconcileGate', {})
    const implementation = fixture('reexport-impl.mjs', `
export function apply(ctx, config) {
  ctx.on('reconcile/reexport', () => ({ version: 'v1', config }))
}
`)
    const entry = fixture('reexport-entry.mjs', `
export { apply } from './reexport-impl.mjs'
export const inject = ['reconcileGate']
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'reconcile',
    validate: value => ({ value: { ...value, validated: true } }),
  },
}
`)
    const entryUrl = pathToFileURL(entry).href
    const original = await ctx.hmr.internal!.import(entryUrl, import.meta.url, {})
    await ctx.plugin(original, {})

    writeFileSync(implementation, `
export function apply(ctx, config) {
  ctx.on('reconcile/reexport', () => ({ version: 'v2', config }))
}
`)
    const result = await ctx.hmr.reconcile({ files: [implementation] })

    expect(result.pending).to.deep.equal([])
    expect(result.replaced).to.have.length(1)
    expect(Object.keys(result.replaced[0].inject)).to.deep.equal(['reconcileGate'])
    expect(ctx.bail('reconcile/reexport' as any)).to.deep.equal({ version: 'v2', config: { validated: true } })
    // the entry module is refreshed as well
    const refreshed = await ctx.hmr.internal!.import(entryUrl, import.meta.url, {})
    expect(refreshed.apply).to.not.equal(original.apply)
    expect(ctx.registry.get(refreshed)).to.equal(result.replaced[0].runtime)
  })

  it('reloads a plugin when a shared dependency inside node_modules changes', async () => {
    await setup()
    const dir = resolve(fixtureDir, 'node_modules/shared')
    mkdirSync(dir, { recursive: true })
    const dep = resolve(dir, 'index.js')
    writeFileSync(dep, `export const value = 'a'\n`)

    await load('node-dep.ts', `
import { value } from 'shared'

export function apply(ctx: any) {
  ctx.on('reconcile/node-dep' as any, () => value)
}
`)
    expect(ctx.bail('reconcile/node-dep')).to.equal('a')

    writeFileSync(dep, `export const value = 'b'\n`)
    const result = await ctx.hmr.reconcile({ files: [dep] })
    expect(result.replaced).to.have.length(1)
    expect(ctx.bail('reconcile/node-dep')).to.equal('b')
  })

  it('reports files it cannot apply', async () => {
    await setup()
    const orphan = fixture('orphan.ts', 'export const value = 1\n')
    await ctx.hmr.internal!.import(pathToFileURL(orphan).href, import.meta.url, {})
    const data = fixture('data.txt', 'data')

    const result = await ctx.hmr.reconcile({ files: [orphan, data] })

    expect(result.replaced).to.deep.equal([])
    expect(result.pending).to.have.deep.members([
      { url: pathToFileURL(data).href, reason: 'not-loaded' },
      { url: pathToFileURL(orphan).href, reason: 'no-plugin' },
    ])
  })

  it('aborts the batch when a module fails to import', async () => {
    await setup()
    const path = await load('abort.ts', plugin('abort', 'v1'))

    writeFileSync(path, 'export function apply(ctx {{{ BROKEN')
    const aborted = await ctx.hmr.reconcile({ files: [path] })

    expect(aborted.aborted).to.be.ok
    expect(aborted.replaced).to.deep.equal([])
    expect(ctx.bail('reconcile/abort' as any)).to.equal('v1')

    // the module cache is restored, so the next change is applied normally
    writeFileSync(path, plugin('abort', 'v2'))
    const fixed = await ctx.hmr.reconcile({ files: [path] })
    expect(fixed.aborted).to.be.undefined
    expect(ctx.bail('reconcile/abort' as any)).to.equal('v2')
  })

  it('aborts the batch when a module does not export a plugin', async () => {
    await setup()
    const path = await load('invalid.ts', plugin('invalid', 'v1'))

    writeFileSync(path, `export const apply = 'not a function'\n`)
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.aborted).to.be.ok
    expect(ctx.bail('reconcile/invalid' as any)).to.equal('v1')
  })

  it('leaves a fiber failed when the new plugin fails to apply', async () => {
    await setup()
    const path = await load('failed.ts', plugin('failed', 'v1'))

    writeFileSync(path, plugin('failed', 'v2', `throw new Error('apply failed')`))
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.aborted).to.be.undefined
    expect(result.replaced).to.deep.equal([])
    expect(result.failed).to.have.length(1)
    expect(result.failed[0].fiber.state).to.equal(FiberState.FAILED)
    expect((result.failed[0].error as Error).message).to.equal('apply failed')
  })

  it('requires a restart for a host module', async () => {
    await setup()
    const path = await load('host.ts', plugin('host', 'v1'))
    const other = await load('other.ts', plugin('other', 'v1'))
    const url = pathToFileURL(path).href
    ctx.hmr.hosts.add(url)

    writeFileSync(path, plugin('host', 'v2'))
    writeFileSync(other, plugin('other', 'v2'))
    const result = await ctx.hmr.reconcile({ files: [path, other] })

    expect(result.restartReason).to.include('host.ts')
    expect(result.replaced).to.deep.equal([])
    expect(result.pending).to.have.deep.members([
      { url, reason: 'host-module' },
      { url: pathToFileURL(other).href, reason: 'restart-required' },
    ])
    expect(ctx.bail('reconcile/host' as any)).to.equal('v1')
    expect(ctx.bail('reconcile/other' as any)).to.equal('v1')
  })

  it('runs transactions one at a time', async () => {
    await setup()
    const slow = await load('queue-slow.ts', plugin('slow', 'v1'))
    const fast = await load('queue-fast.ts', plugin('fast', 'v1'))

    writeFileSync(slow, plugin('slow', 'v2', `
  await new Promise(resolve => setTimeout(resolve, 300))
  stats.slowDone = performance.now()`))
    writeFileSync(fast, plugin('fast', 'v2', `stats.fastApplied = performance.now()`))
    const [first, second] = await Promise.all([
      ctx.hmr.reconcile({ files: [slow] }),
      ctx.hmr.reconcile({ files: [fast] }),
    ])

    expect(first.replaced).to.have.length(1)
    expect(second.replaced).to.have.length(1)
    expect(stats.fastApplied).to.be.greaterThanOrEqual(stats.slowDone)
  })

  it('rejects a transaction started inside another one', async () => {
    await setup()
    const body = `
  stats.nested = ctx.hmr.reconcile({ files: [] }).then(() => 'resolved', (error) => error.message)
  // a promise reaction keeps the async context it was created in
  stats.later = new Promise(resolve => stats.open = resolve)
    .then(() => ctx.hmr.reconcile({ files: [] }))
    .then(() => 'resolved', (error) => error.message)`
    const path = await load('nested.ts', plugin('nested', 'v1', body).replace(
      `export const name`,
      `export const inject = ['hmr']\n\nexport const name`,
    ))
    expect(await stats.nested).to.equal('resolved')

    writeFileSync(path, plugin('nested', 'v2', body).replace(
      `export const name`,
      `export const inject = ['hmr']\n\nexport const name`,
    ))
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.replaced).to.have.length(1)
    expect(await stats.nested).to.equal('cannot start a transaction inside another transaction')

    // once the transaction is over, its async context no longer counts
    stats.open()
    expect(await stats.later).to.equal('resolved')
  })
})
