import { Context, Fiber, FiberState } from 'cordis'
import { ModuleLoader, unwrapExports } from '@cordisjs/loader-utils'
import Loader from '@cordisjs/plugin-loader'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

  it('fails to start without loader internals', async () => {
    ctx = new Context()
    const spy = vi.spyOn(ModuleLoader, 'fromInternal').mockReturnValue(undefined)
    try {
      fiber = ctx.plugin(Hmr)
      await fiber.await().catch(() => {})
    } finally {
      spy.mockRestore()
    }
    expect(fiber.state).to.equal(FiberState.FAILED)
    expect(ctx.get('hmr')).to.be.undefined
  })

  it('replaces an entry plugin in place', async () => {
    await setup()
    const path = await load('entry.ts', plugin('entry', 'v1', `
  ctx.effect(() => () => stats.entryDisposed = true)`))
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === './__reconcile__/entry.ts')!
    const inner = entry.innerFiber!
    expect(ctx.bail('reconcile/entry' as any)).to.equal('v1')

    writeFileSync(path, plugin('entry', 'v2'))
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.settledFibers).to.have.length(1)
    expect(result.settledFibers[0].state).to.equal(FiberState.ACTIVE)
    expect(result.importFailures).to.deep.equal([])
    expect(stats.entryDisposed).to.equal(true)
    // the entry keeps its fiber, which now runs the new plugin
    expect(entry.innerFiber).to.equal(inner)
    expect(Object.getPrototypeOf(inner)).to.equal(result.settledFibers[0])
    expect(entry.disabled).to.equal(false)
    expect(ctx.bail('reconcile/entry' as any)).to.equal('v2')
  })

  it('imports a module again after it failed in an aborted attempt', async () => {
    await setup()
    const path = await load('added-entry.ts', plugin('added', 'v1'))
    const added = fixture('added-dep.ts', `throw new Error('added v1')\n`)
    writeFileSync(path, `import './added-dep.ts'\n` + plugin('added', 'v2'))
    expect((await ctx.hmr.reconcile({ files: [path] })).importFailures).to.have.length(1)

    // only the entry is reconciled again, as the caller knows no more
    writeFileSync(added, `export {}\n`)
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.importFailures).to.deep.equal([])
    expect(ctx.bail('reconcile/added' as any)).to.equal('v2')
  })

  it('imports a JSON module again after it failed in an aborted attempt', async () => {
    await setup()
    const path = await load('json-entry.mjs', `
export function apply(ctx) {
  ctx.on('reconcile/json', () => 'v1')
}
`)
    const data = fixture('json-data.json', '{"value":')
    writeFileSync(path, `
import data from './json-data.json' with { type: 'json' }

export function apply(ctx) {
  ctx.on('reconcile/json', () => data.value)
}
`)
    expect((await ctx.hmr.reconcile({ files: [path] })).importFailures).to.have.length(1)

    writeFileSync(data, '{"value":"v2"}')
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.importFailures).to.deep.equal([])
    expect(ctx.bail('reconcile/json' as any)).to.equal('v2')
  })

  it('imports a module again after its evaluation failed for a reason outside its file', async () => {
    await setup()
    const url = pathToFileURL(fixture('transient.mjs', `
if (!globalThis.__hmrReconcile.transientReady) throw new Error('not ready')
export const value = 'ready'
`)).href
    await expect(ctx.hmr.internal.import(url, import.meta.url, {})).rejects.toThrow('not ready')

    stats.transientReady = true
    await ctx.hmr.reconcile({ files: [] })

    const { value } = await ctx.hmr.internal.import(url, import.meta.url, {})
    expect(value).to.equal('ready')
  })

  it('keeps a module that is still being imported', async () => {
    await setup()
    const url = pathToFileURL(fixture('pending-dep.mjs', `
const stats = globalThis.__hmrReconcile
stats.pendingEvaluated = (stats.pendingEvaluated ?? 0) + 1
export const state = {}
`)).href

    const pending = ctx.hmr.internal.import(url, import.meta.url, {})
    await ctx.hmr.reconcile({ files: [] })

    const first = await pending
    const later = await ctx.hmr.internal.import(url, import.meta.url, {})
    expect(later.state).to.equal(first.state)
    expect(stats.pendingEvaluated).to.equal(1)
  })

  it('keeps the job of a module when its job of another type fails', async () => {
    await setup()
    // the failing plugin is imported first, so that it creates the cache entry of the shared module
    const failing = await load('slot-failing.mjs', `export function apply() {}\n`)
    const importer = await load('slot-importer.mjs', `export function apply() {}\n`)
    const shared = fixture('slot-shared.mjs', `export default {}\n`)

    writeFileSync(failing, `
import data from './slot-shared.mjs' with { type: 'json' }

export function apply() {}
`)
    writeFileSync(importer, `
import data from './slot-shared.mjs'

export function apply(ctx) {
  ctx.on('reconcile/slot', () => data)
}
`)
    const result = await ctx.hmr.reconcile({ files: [failing, importer] })

    expect(result.settledFibers).to.have.length(1)
    expect(result.importFailures).to.have.length(1)
    // the next transaction removes the failed job
    await ctx.hmr.reconcile({ files: [] })
    const later = await ctx.hmr.internal.import(pathToFileURL(shared).href, import.meta.url, {})
    expect(ctx.bail('reconcile/slot' as any)).to.equal(later.default)
  })

  it('follows the dependencies of a module job when its job of another type fails to link', async () => {
    await setup()
    const core = fixture('edge-core.mjs', `export const value = 'v1'\n`)
    const owner = await load('edge-owner.mjs', `import './edge-core.mjs'\nexport function apply() {}\n`)
    const failing = await load('edge-failing.mjs', `export function apply() {}\n`)
    const importer = await load('edge-importer.mjs', `
export function apply(ctx) {
  ctx.on('reconcile/edge', () => 'v1')
}
`)
    fixture('edge-dep.mjs', `export { value as default } from './edge-core.mjs'\n`)

    writeFileSync(core, `export const value = 'v2'\n`)
    writeFileSync(owner, `import './edge-core.mjs'\nthrow new Error('owner failed')\n`)
    writeFileSync(failing, `
import data from './edge-dep.mjs' with { type: 'json' }

export function apply() {}
`)
    writeFileSync(importer, `
import data from './edge-dep.mjs'

export function apply(ctx) {
  ctx.on('reconcile/edge', () => data)
}
`)
    const result = await ctx.hmr.reconcile({ files: [core, owner, failing, importer] })

    // the importer links against the changed module of the failed owner
    expect(result.settledFibers).to.deep.equal([])
    expect(ctx.bail('reconcile/edge' as any)).to.equal('v1')
  })

  it('replaces a service', async () => {
    await setup()
    const service = (value: string) => `
import { Context, Service } from 'cordis'

export default class ReconcileService extends Service {
  value = '${value}'

  constructor(ctx: Context) {
    super(ctx, 'reconcileService')
  }
}
`
    const path = await load('service.ts', service('v1'))
    expect(ctx.get('reconcileService').value).to.equal('v1')

    writeFileSync(path, service('v2'))
    await ctx.hmr.reconcile({ files: [path] })
    expect(ctx.get('reconcileService').value).to.equal('v2')
  })

  it('replaces a plugin when one of its dependencies changes', async () => {
    await setup()
    const dep = fixture('dep.ts', `export const value = 'v1'\n`)
    fixture('common.ts', `export const value = 'common'\n`)
    await load('dependent.ts', `
import { Context } from 'cordis'
import { value } from './dep.ts'
import './common.ts'

export function apply(ctx: Context) {
  ctx.on('reconcile/dependent' as any, () => value)
}
`)
    // shares an unchanged module with the dependent plugin, but not the changed one
    await load('sibling.ts', `
import { Context } from 'cordis'
import './common.ts'

const stats: any = (globalThis as any).__hmrReconcile

export function apply(ctx: Context) {
  stats.siblingApplied = (stats.siblingApplied ?? 0) + 1
}
`)
    expect(stats.siblingApplied).to.equal(1)

    writeFileSync(dep, `export const value = 'v2'\n`)
    const result = await ctx.hmr.reconcile({ files: [dep] })

    expect(result.settledFibers).to.have.length(1)
    expect(ctx.bail('reconcile/dependent' as any)).to.equal('v2')
    expect(stats.siblingApplied).to.equal(1)
  })

  it('replaces the inner fiber of an entry with an injection scope in place', async () => {
    await setup()
    ctx.provide('reconcileScope', {})
    const path = fixture('scoped.ts', plugin('scoped', 'v1'))
    const id = await ctx.loader.create({ name: './__reconcile__/scoped.ts', inject: ['reconcileScope'] })
    const entry = ctx.loader.store[id]!
    await ctx.loader.await()
    const outer = entry.outerFiber!
    const inner = entry.innerFiber!
    expect(outer).to.be.ok
    expect(ctx.bail('reconcile/scoped' as any)).to.equal('v1')

    writeFileSync(path, plugin('scoped', 'v2'))
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.settledFibers).to.have.length(1)
    // both fibers are kept
    expect(entry.outerFiber === outer).to.equal(true)
    expect(entry.innerFiber).to.equal(inner)
    expect(Object.getPrototypeOf(inner)).to.equal(result.settledFibers[0])
    expect(ctx.bail('reconcile/scoped' as any)).to.equal('v2')
  })

  it('accepts a file URL', async () => {
    await setup()
    const path = await load('url.ts', plugin('url', 'v1'))

    writeFileSync(path, plugin('url', 'v2'))
    const result = await ctx.hmr.reconcile({ files: [pathToFileURL(path)] })

    expect(result.settledFibers).to.have.length(1)
    expect(ctx.bail('reconcile/url' as any)).to.equal('v2')
  })

  it('replaces a plugin that no entry manages', async () => {
    await setup()
    const path = fixture('direct.ts', plugin('direct', 'v1'))
    const exports = await ctx.hmr.internal.import(pathToFileURL(path).href, import.meta.url, {})
    const direct = ctx.plugin(unwrapExports(exports))
    await direct
    expect(ctx.bail('reconcile/direct' as any)).to.equal('v1')

    writeFileSync(path, plugin('direct', 'v2'))
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.settledFibers).to.have.length(1)
    // the fiber returned by `ctx.plugin()` stays valid
    expect(Object.getPrototypeOf(direct)).to.equal(result.settledFibers[0])
    expect(direct.state).to.equal(FiberState.ACTIVE)
    expect(ctx.bail('reconcile/direct' as any)).to.equal('v2')
  })

  // The `data:` module has no path, but re-importing it picks up its changed dependency.
  it('replaces a plugin exported from a data: URL', async () => {
    await setup()
    const path = fixture('data-impl.ts', plugin('data', 'v1'))
    const url = `data:text/javascript,export * from ${JSON.stringify(pathToFileURL(path).href)}`
    const exports = await ctx.hmr.internal.import(url, import.meta.url, {})
    await ctx.plugin(unwrapExports(exports))
    expect(ctx.bail('reconcile/data' as any)).to.equal('v1')

    writeFileSync(path, plugin('data', 'v2'))
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.settledFibers).to.have.length(1)
    expect(ctx.bail('reconcile/data' as any)).to.equal('v2')
  })

  it('refreshes a disabled plugin for when it is enabled again', async () => {
    await setup()
    const dep = fixture('disabled-dep.ts', `export const value = 'v1'\n`)
    fixture('disabled.ts', `
import { Context } from 'cordis'
import { value } from './disabled-dep.ts'

export function apply(ctx: Context) {
  ctx.on('reconcile/disabled' as any, () => value)
}
`)
    const id = await ctx.loader.create({ name: './__reconcile__/disabled.ts' })
    await ctx.loader.store[id]!.innerFiber!.await()
    await ctx.loader.update(id, { disabled: true })

    writeFileSync(dep, `export const value = 'v2'\n`)
    await ctx.hmr.reconcile({ files: [dep] })

    await ctx.loader.update(id, { disabled: false })
    await ctx.loader.store[id]!.innerFiber!.await()
    expect(ctx.bail('reconcile/disabled' as any)).to.equal('v2')
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
    const original = await ctx.hmr.internal.import(entryUrl, import.meta.url, {})
    await ctx.plugin(original, {})

    writeFileSync(implementation, `
export function apply(ctx, config) {
  ctx.on('reconcile/reexport', () => ({ version: 'v2', config }))
}
`)
    const result = await ctx.hmr.reconcile({ files: [implementation] })

    expect(result.settledFibers).to.have.length(1)
    expect(Object.keys(result.settledFibers[0].inject)).to.deep.equal(['reconcileGate'])
    expect(ctx.bail('reconcile/reexport' as any)).to.deep.equal({ version: 'v2', config: { validated: true } })
    // the entry module is refreshed as well
    const refreshed = await ctx.hmr.internal.import(entryUrl, import.meta.url, {})
    expect(refreshed.apply).to.not.equal(original.apply)
    expect(ctx.registry.get(refreshed)).to.equal(result.settledFibers[0].runtime)
  })

  it('reloads the plugins under a changed root', async () => {
    await setup()
    mkdirSync(resolve(fixtureDir, 'root'), { recursive: true })
    const a = await load('root/a.ts', plugin('rootA', 'v1'))
    const b = await load('root/b.ts', plugin('rootB', 'v1'))
    const c = await load('root/c.ts', plugin('rootC', 'v1'))
    const root = resolve(fixtureDir, 'root')

    // the first pass records the baseline: a module loaded after the last
    // observation cannot be proven unchanged, so it joins the batch once
    const cold = await ctx.hmr.reconcile({ roots: [root] })
    expect(cold.settledFibers).to.have.length(3)

    writeFileSync(a, plugin('rootA', 'v2'))
    writeFileSync(b, plugin('rootB', 'v2'))
    writeFileSync(c, plugin('rootC', 'v2'))
    const result = await ctx.hmr.reconcile({ roots: [root] })
    expect(result.settledFibers).to.have.length(3)
    expect(ctx.bail('reconcile/rootA' as any)).to.equal('v2')
    expect(ctx.bail('reconcile/rootB' as any)).to.equal('v2')
    expect(ctx.bail('reconcile/rootC' as any)).to.equal('v2')
  })

  it('reloads a plugin when a package under node_modules is rewritten', async () => {
    await setup()
    // the layout #243 names first: a package at a fixed path, rewritten where
    // it stands, so its real path does not change
    const pkgDir = resolve(fixtureDir, 'node_modules/pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(resolve(pkgDir, 'package.json'), JSON.stringify({ name: 'pkg', main: 'index.js' }))
    writeFileSync(resolve(pkgDir, 'index.js'), `module.exports = 'v1'\n`)

    fixture('uses-pkg.ts', `
import value from 'pkg'

export const name = 'usesPkg'

export async function apply(ctx: any) {
  ctx.on('reconcile/usesPkg' as any, () => value)
}
`)
    const id = await ctx.loader.create({ name: './__reconcile__/uses-pkg.ts' })
    await ctx.loader.store[id]!.innerFiber!.await().catch(() => {})
    expect(ctx.bail('reconcile/usesPkg' as any)).to.equal('v1')

    // the baseline: the plugin was loaded after the service started, so it has
    // no record yet and joins the batch once, then nothing is left to do
    const cold = await ctx.hmr.reconcile({ roots: [fixtureDir] })
    expect(cold.settledFibers).to.have.length(1)
    const steady = await ctx.hmr.reconcile({ roots: [fixtureDir] })
    expect(steady.settledFibers).to.have.length(0)

    // a package update that rewrites the file in place, at the same size
    writeFileSync(resolve(pkgDir, 'index.js'), `module.exports = 'v2'\n`)

    const result = await ctx.hmr.reconcile({ roots: [pkgDir] })
    expect(result.settledFibers).to.have.length(1)
    expect(ctx.bail('reconcile/usesPkg' as any)).to.equal('v2')
  })

  it('reports a host module once when a root and a file both name it', async () => {
    // the service reads its host modules from `process.argv[1]`, so an entry
    // loaded before it starts becomes one
    ctx = new Context()
    fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    const path = await load('host.ts', plugin('host', 'v1'))
    const argv = process.argv[1]
    process.argv[1] = path
    try {
      await ctx.plugin(Hmr)
    } finally {
      process.argv[1] = argv
    }
    const url = pathToFileURL(path).href
    expect(ctx.hmr.hostModules.has(url)).to.equal(true)

    writeFileSync(path, plugin('host', 'v2'))
    // the same module arrives once from `files` and once from the root; it can
    // only be applied by restarting, and it is one module, not two
    const result = await ctx.hmr.reconcile({ files: [url], roots: [fixtureDir] })
    expect(result.skippedHostModules).to.deep.equal([url])
    expect(result.settledFibers).to.have.length(0)
  })

  it('skips a module whose namespace cannot be read', async () => {
    await setup()
    await load('present.ts', plugin('present', 'v1'))
    await ctx.hmr.reconcile({ roots: [fixtureDir] })

    // a job whose bindings cannot be read is skipped rather than failing the
    // transaction; the cache is the only way to reach that state, and it is the
    // structure the service reads
    const internal = ModuleLoader.fromInternal()!
    const fake = pathToFileURL(resolve(fixtureDir, 'unreadable.ts')).href
    let reads = 0
    Map.prototype.set.call(internal.loadCache, fake, {
      javascript: {
        module: {
          getStatus: () => 0,
          getNamespace() { reads++; throw new Error('boom') },
        },
      },
    } as any)
    try {
      const result = await ctx.hmr.reconcile({ files: [fake] })
      // the namespace was read once, threw, and the module was skipped
      expect(reads).to.equal(1)
      expect(result.settledFibers).to.have.length(0)
    } finally {
      Map.prototype.delete.call(internal.loadCache, fake)
    }
  })

  it('logs a plugin it could not replace and keeps the rest of the batch', async () => {
    await setup()
    const path = await load('replace.ts', plugin('replace', 'v1'))
    await ctx.hmr.reconcile({ roots: [fixtureDir] })

    writeFileSync(path, plugin('replace', 'v2'))
    const warn = vi.spyOn(ctx.logger, 'warn')
    // a replacement that throws must not take the transaction down with it
    const spy = vi.spyOn(ctx.registry, 'replace').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    try {
      const result = await ctx.hmr.reconcile({ roots: [fixtureDir] })
      expect(result.settledFibers).to.have.length(0)
      expect(warn).toHaveBeenCalledWith('failed to reload plugin at %C', expect.anything())
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps going when a cache entry has no job or no module', async () => {
    await setup()
    const path = await load('present.ts', plugin('present', 'v1'))
    await ctx.hmr.reconcile({ roots: [fixtureDir] })

    // an entry may hold an empty slot, or a job whose module was never created;
    // both are skipped rather than dereferenced
    const internal = ModuleLoader.fromInternal()!
    const emptySlot = pathToFileURL(resolve(fixtureDir, 'empty-slot.ts')).href
    const noModule = pathToFileURL(resolve(fixtureDir, 'no-module.ts')).href
    Map.prototype.set.call(internal.loadCache, emptySlot, { javascript: undefined } as any)
    Map.prototype.set.call(internal.loadCache, noModule, { javascript: {} } as any)
    try {
      writeFileSync(path, plugin('present', 'v2'))
      const skipped = await ctx.hmr.reconcile({ files: [emptySlot, noModule] })
      expect(skipped.settledFibers).to.have.length(0)
      // and the service is still able to work afterwards
      const result = await ctx.hmr.reconcile({ roots: [fixtureDir] })
      expect(result.settledFibers).to.have.length(1)
      expect(ctx.bail('reconcile/present' as any)).to.equal('v2')
    } finally {
      Map.prototype.delete.call(internal.loadCache, emptySlot)
      Map.prototype.delete.call(internal.loadCache, noModule)
    }
  })

  it('skips a plugin disposed while its replacement was importing', async () => {
    await setup()
    const path = await load('disposed.ts', plugin('disposed', 'v1'))
    const id = [...ctx.loader.entries()].find(entry => entry.options.name === './__reconcile__/disposed.ts')!.id
    await ctx.hmr.reconcile({ roots: [fixtureDir] })

    // the new version removes its own entry at module scope, i.e. while stage 1
    // is importing it, so stage 2 finds no fiber left to replace
    ;(globalThis as any).__hmrReconcile.removeSelf = () => ctx.loader.remove(id)
    writeFileSync(path, `
;(globalThis as any).__hmrReconcile.removeSelf()
export const name = 'disposed'
export async function apply(ctx: any) {}
`)
    const warn = vi.spyOn(ctx.logger, 'warn')
    try {
      const result = await ctx.hmr.reconcile({ roots: [fixtureDir] })
      expect(result.settledFibers).to.have.length(0)
      expect(warn).not.toHaveBeenCalledWith('failed to reload plugin at %C', expect.anything())
    } finally {
      delete (globalThis as any).__hmrReconcile.removeSelf
    }
  })

  it('leaves an orphan evicted when it reaches a unit that committed', async () => {
    await setup()
    const m1 = fixture('orphan-ok.ts', `export const v = 'v1'\n`)
    const m2 = fixture('orphan-bad.ts', `export const v = 'v1'\n`)
    const p1 = fixture('orphan-ok-plugin.ts', `
import { v } from './orphan-ok.ts'

export const name = 'orphanOk'

export async function apply(ctx: any) {
  ctx.on('reconcile/orphanOk' as any, () => v)
}
`)
    const p2 = fixture('orphan-bad-plugin.ts', `
import { v } from './orphan-bad.ts'

export const name = 'orphanBad'

export async function apply(ctx: any) {
  ctx.on('reconcile/orphanBad' as any, () => v)
}
`)
    // the orphan reaches both units: the one that commits and the one that aborts
    const o = fixture('orphan-both.ts', `
import { name as ok } from './orphan-ok-plugin.ts'
import { name as bad } from './orphan-bad-plugin.ts'

export const o = 'v1:' + ok + bad
`)
    for (const name of ['orphan-ok-plugin.ts', 'orphan-bad-plugin.ts']) {
      const id = await ctx.loader.create({ name: `./__reconcile__/${name}` })
      await ctx.loader.store[id]!.innerFiber!.await().catch(() => {})
    }
    await ModuleLoader.fromInternal()!.import(pathToFileURL(o).href, import.meta.url, {}).catch(() => {})
    await ctx.hmr.reconcile({ roots: [fixtureDir] })

    writeFileSync(m1, `export const v = 'v2'\n`)
    writeFileSync(m2, `export const v = 'v2'\n`)
    writeFileSync(p1, `
import { v } from './orphan-ok.ts'

export const name = 'orphanOk'

export async function apply(ctx: any) {
  ctx.on('reconcile/orphanOk' as any, () => v + '!')
}
`)
    // a file that cannot be parsed: its unit aborts
    writeFileSync(p2, 'export const name = "orphanBad"\n\nexport async function apply(ctx: any) {\n')
    writeFileSync(o, `
import { name as ok } from './orphan-ok-plugin.ts'
import { name as bad } from './orphan-bad-plugin.ts'

export const o = 'v2:' + ok + bad
`)

    const result = await ctx.hmr.reconcile({ files: [m1, m2, p1, p2, o] })
    expect(result.settledFibers).to.have.length(1)
    // neither version of the caches is consistent for the orphan, so it stays
    // evicted rather than being restored with the aborted unit: its next import
    // reads the new code
    const reloaded = await ModuleLoader.fromInternal()!.import(pathToFileURL(o).href, import.meta.url, {}) as any
    expect(reloaded.o).to.equal('v2:orphanOkorphanBad')
  })

  it('covers a CJS-only module in the baseline taken at init', async () => {
    // A CJS module that only another CJS module requires is in `require.cache`
    // and never in `loadCache`. Loaded before the service starts, it must be
    // part of the baseline, or the first roots reconcile reloads the plugin
    // although no file was written.
    const cPath = fixture('init-leaf.cjs', `exports.value = 'v1'\n`)
    fixture('init-mid.cjs', `const { value } = require('./init-leaf.cjs')\n\nexports.value = value\n`)
    const entry = fixture('init-entry.ts', `
import { value } from './init-mid.cjs'

export const name = 'initEntry'

export async function apply(ctx: any) {
  ctx.on('reconcile/initEntry' as any, () => value)
}
`)
    ctx = new Context()
    fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    const id = await ctx.loader.create({ name: './__reconcile__/init-entry.ts' })
    await ctx.loader.store[id]!.innerFiber!.await().catch(() => {})
    expect(ctx.bail('reconcile/initEntry' as any)).to.equal('v1')
    expect(createRequire(import.meta.url).cache[cPath]).to.be.ok

    // the service starts only now, so everything loaded so far is the baseline
    await ctx.plugin(Hmr)
    const cold = await ctx.hmr.reconcile({ roots: [fixtureDir] })
    expect(cold.settledFibers).to.have.length(0)
    expect(ctx.bail('reconcile/initEntry' as any)).to.equal('v1')

    // a real change to the leaf still reaches the plugin
    writeFileSync(cPath, `exports.value = 'v2'\n`)
    const result = await ctx.hmr.reconcile({ roots: [fixtureDir] })
    expect(result.settledFibers).to.have.length(1)
    expect(ctx.bail('reconcile/initEntry' as any)).to.equal('v2')
  }, 30000)

  it('produces no churn across repeated roots reconciles', async () => {
    await setup()
    await load('steady.ts', plugin('steady', 'v1'))
    const cold = await ctx.hmr.reconcile({ roots: [fixtureDir] })
    expect(cold.settledFibers).to.have.length(1)

    for (let i = 0; i < 100; i++) {
      const result = await ctx.hmr.reconcile({ roots: [fixtureDir] })
      expect(result.settledFibers).to.have.length(0)
      expect(result.importFailures).to.have.length(0)
    }
    expect(ctx.bail('reconcile/steady' as any)).to.equal('v1')
  })

  it('ignores a file under the root that was never loaded', async () => {
    await setup()
    await load('quiet.ts', plugin('quiet', 'v1'))
    await ctx.hmr.reconcile({ roots: [fixtureDir] })

    // a file a package operation just added: nothing has imported it, so it
    // is neither recorded nor loaded and must not be reported
    fixture('unrelated.ts', plugin('unrelated', 'v1'))
    const result = await ctx.hmr.reconcile({ roots: [fixtureDir] })
    expect(result.settledFibers).to.have.length(0)
    expect(result.importFailures).to.have.length(0)
  })

  it('catches a same-size rewrite under a root that hides its timestamp', async () => {
    await setup()
    const path = await load('pinned.ts', plugin('pinned', 'v1'))
    const url = pathToFileURL(path).href
    await ctx.hmr.reconcile({ roots: [fixtureDir] })

    // A transaction observes what it reloaded right after importing it, so a
    // write that just landed is recorded with its content hash. Pin the mtime
    // first, so the observation below is a young one whatever the clock
    // granularity of the file system is.
    const t = Date.now() / 1000
    utimesSync(path, t, t)
    await ctx.hmr.reconcile({ files: [url] })

    // rewrite with the same size and pin the mtime back: the recorded fields
    // are identical, so only the recorded content hash can tell the versions
    // apart
    writeFileSync(path, plugin('pinned', 'v2'))
    utimesSync(path, t, t)

    const result = await ctx.hmr.reconcile({ roots: [fixtureDir] })
    expect(result.settledFibers).to.have.length(1)
    expect(ctx.bail('reconcile/pinned' as any)).to.equal('v2')
  })

  it('retries a batch that aborted without another change', async () => {
    await setup()
    const good = await load('retry-good.ts', plugin('retryGood', 'v1'))
    const bad = await load('retry-bad.ts', plugin('retryBad', 'v1'))
    await ctx.hmr.reconcile({ roots: [fixtureDir] })

    writeFileSync(good, plugin('retryGood', 'v2'))
    // a file that cannot even be parsed: the unit it belongs to aborts while
    // the other one commits
    writeFileSync(bad, 'export const name = "retryBad"\n\nexport async function apply(ctx: any) {\n')

    const first = await ctx.hmr.reconcile({ roots: [fixtureDir] })
    expect(first.settledFibers).to.have.length(1)
    expect(first.importFailures).to.have.length(1)
    expect(ctx.bail('reconcile/retryGood' as any)).to.equal('v2')
    expect(ctx.bail('reconcile/retryBad' as any)).to.equal('v1')

    // nothing on disk changed since, and the runtime still runs the old code:
    // the next call has to report the same failure rather than claim the tree
    // is in line with the disk
    const second = await ctx.hmr.reconcile({ roots: [fixtureDir] })
    expect(second.settledFibers).to.have.length(0)
    expect(second.importFailures).to.have.length(1)
  })

  it('logs a debug message for a change that needs no action', async () => {
    await setup()
    await load('present.ts', plugin('present', 'v1'))
    await ctx.hmr.reconcile({ roots: [fixtureDir] })

    // a file nothing ever imported, and that is gone again by the time it is
    // reported: there is no module to reload, so it is logged rather than
    // described in the result (#244)
    const missing = fixture('missing.ts', plugin('missing', 'v1'))
    rmSync(missing)

    const spy = vi.spyOn(ctx.logger, 'debug')
    const result = await ctx.hmr.reconcile({ files: [pathToFileURL(missing).href] })
    expect(spy).toHaveBeenCalledWith('skip %C (%s)', expect.stringContaining('missing.ts'), 'not loaded')
    expect(result.settledFibers).to.have.length(0)
    expect(result.importFailures).to.have.length(0)
  })

  it('does not fail a transaction on a file url that does not parse', async () => {
    await setup()
    await load('present.ts', plugin('present', 'v1'))
    await ctx.hmr.reconcile({ roots: [fixtureDir] })

    // `new URL()` accepts both, and `fileURLToPath()` throws on both: a caller
    // that builds a `file:` string by hand can produce them, and one bad entry
    // must not fail the transaction after the cache sweep has already run
    const spy = vi.spyOn(ctx.logger, 'debug')
    const result = await ctx.hmr.reconcile({ files: ['file:///100%.js', 'file:///a%2.node'] })
    expect(result.settledFibers).to.have.length(0)
    expect(result.importFailures).to.have.length(0)
    expect(result.skippedHostModules).to.have.length(0)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('refreshes a module that no plugin depends on for its next import', async () => {
    await setup()
    const orphan = fixture('orphan.ts', 'export const value = 1\n')
    const url = pathToFileURL(orphan).href
    const before = await ctx.hmr.internal.import(url, import.meta.url, {})
    const data = fixture('data.txt', 'data')

    writeFileSync(orphan, 'export const value = 2\n')
    const result = await ctx.hmr.reconcile({ files: [orphan, data] })

    expect(result.settledFibers).to.deep.equal([])
    // existing references keep the old module
    expect(before.value).to.equal(1)
    const after = await ctx.hmr.internal.import(url, import.meta.url, {})
    expect(after.value).to.equal(2)
  })

  it('does not apply a unit whose module fails to import', async () => {
    await setup()
    const path = await load('abort.ts', plugin('abort', 'v1'))

    writeFileSync(path, 'export function apply(ctx {{{ BROKEN')
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.settledFibers).to.deep.equal([])
    expect(result.importFailures).to.have.length(1)
    expect(result.importFailures[0].urls).to.include(pathToFileURL(path).href)
    expect(ctx.bail('reconcile/abort' as any)).to.equal('v1')

    // the module cache is restored, so the next change is applied normally
    writeFileSync(path, plugin('abort', 'v2'))
    await ctx.hmr.reconcile({ files: [path] })
    expect(ctx.bail('reconcile/abort' as any)).to.equal('v2')
  })

  it('does not apply a unit whose module does not export a plugin', async () => {
    await setup()
    const path = await load('invalid.ts', plugin('invalid', 'v1', `
  ctx.effect(() => () => stats.invalidDisposed = true)`))

    writeFileSync(path, `export const apply = 'not a function'\n`)
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.importFailures).to.have.length(1)
    // the running instance is not disposed
    expect(stats.invalidDisposed).to.be.undefined
    expect(ctx.bail('reconcile/invalid' as any)).to.equal('v1')
  })

  it('applies a unit when another unit fails to import', async () => {
    await setup()
    fixture('unit-common.ts', `export const value = 'common'\n`)
    const shared = (name: string, value: string) => `import './unit-common.ts'\n` + plugin(name, value)
    const broken = await load('unit-broken.ts', shared('broken', 'v1'))
    const healthy = await load('unit-healthy.ts', shared('healthy', 'v1'))

    // the two plugins only share an unchanged module
    writeFileSync(broken, 'export function apply(ctx {{{ BROKEN')
    writeFileSync(healthy, shared('healthy', 'v2'))
    const result = await ctx.hmr.reconcile({ files: [broken, healthy] })

    expect(result.settledFibers).to.have.length(1)
    expect(result.importFailures).to.have.length(1)
    expect(result.importFailures[0].urls).to.include(pathToFileURL(broken).href)
    expect(result.importFailures[0].urls).to.not.include(pathToFileURL(healthy).href)
    expect(ctx.bail('reconcile/broken' as any)).to.equal('v1')
    expect(ctx.bail('reconcile/healthy' as any)).to.equal('v2')

    // the failed unit is retried on its own
    writeFileSync(broken, shared('broken', 'v2'))
    const retried = await ctx.hmr.reconcile({ files: [broken] })
    expect(retried.importFailures).to.deep.equal([])
    expect(ctx.bail('reconcile/broken' as any)).to.equal('v2')
  })

  it('aborts plugins that share a changed module together', async () => {
    await setup()
    const dep = fixture('joint-dep.ts', `export const value = 'v1'\n`)
    const dependent = (name: string, body = '') => `
import { Context } from 'cordis'
import { value } from './joint-dep.ts'
${body}
export function apply(ctx: Context) {
  ctx.on('reconcile/${name}' as any, () => value)
}
`
    const left = await load('joint-left.ts', dependent('left'))
    await load('joint-right.ts', dependent('right'))

    writeFileSync(dep, `export const value = 'v2'\n`)
    writeFileSync(left, dependent('left', `throw new Error('left failed')`))
    const result = await ctx.hmr.reconcile({ files: [dep, left] })

    expect(result.settledFibers).to.deep.equal([])
    expect(result.importFailures).to.have.length(1)
    expect(result.importFailures[0].urls).to.include(pathToFileURL(dep).href)
    expect(ctx.bail('reconcile/left' as any)).to.equal('v1')
    expect(ctx.bail('reconcile/right' as any)).to.equal('v1')
  })

  it('aborts a plugin that newly imports a changed module of a failed unit', async () => {
    await setup()
    const dep = fixture('adopt-dep.ts', `export const value = 'v1'\n`)
    const owner = await load('adopt-owner.ts', `import './adopt-dep.ts'\n` + plugin('owner', 'v1'))
    const adopter = await load('adopt-adopter.ts', plugin('adopter', 'v1'))

    // the adopter is unrelated to the owner before the change
    writeFileSync(dep, `export const value = 'v2'\n`)
    writeFileSync(owner, `import './adopt-dep.ts'\nthrow new Error('owner failed')\n`)
    writeFileSync(adopter, `
import { Context } from 'cordis'
import { value } from './adopt-dep.ts'

export function apply(ctx: Context) {
  ctx.on('reconcile/adopter' as any, () => value)
}
`)
    const result = await ctx.hmr.reconcile({ files: [dep, owner, adopter] })

    expect(result.settledFibers).to.deep.equal([])
    expect(result.importFailures).to.have.length(1)
    expect(result.importFailures[0].urls).to.include.members([
      pathToFileURL(dep).href,
      pathToFileURL(adopter).href,
    ])
    expect(ctx.bail('reconcile/owner' as any)).to.equal('v1')
    expect(ctx.bail('reconcile/adopter' as any)).to.equal('v1')
  })

  it('aborts a plugin that newly requires a changed module of a failed unit', async () => {
    await setup()
    const dep = fixture('require-dep.cjs', `exports.value = 'v1'\n`)
    const owner = await load('require-owner.ts', `import './require-dep.cjs'\n` + plugin('owner', 'v1'))
    const requirer = await load('require-requirer.cjs', `
exports.apply = (ctx) => ctx.on('reconcile/requirer', () => 'v1')
`)

    // the requirer is unrelated to the owner before the change
    writeFileSync(dep, `exports.value = 'v2'\n`)
    writeFileSync(owner, `import './require-dep.cjs'\nthrow new Error('owner failed')\n`)
    writeFileSync(requirer, `
const { value } = require('./require-dep.cjs')
exports.apply = (ctx) => ctx.on('reconcile/requirer', () => value)
`)
    const result = await ctx.hmr.reconcile({ files: [dep, owner, requirer] })

    expect(result.settledFibers).to.deep.equal([])
    expect(result.importFailures).to.have.length(1)
    expect(result.importFailures[0].urls).to.include.members([
      pathToFileURL(dep).href,
      pathToFileURL(requirer).href,
    ])
    expect(ctx.bail('reconcile/requirer' as any)).to.equal('v1')
  })

  it('shares a module first loaded by a failed unit with a unit that imports it dynamically', async () => {
    await setup()
    const failing = await load('dynamic-failing.ts', plugin('failing', 'v1'))
    const importer = await load('dynamic-importer.ts', plugin('importer', 'v1'))
    const shared = pathToFileURL(resolve(fixtureDir, 'dynamic-shared.ts')).href

    fixture('dynamic-shared.ts', `export const state = {}\n`)
    writeFileSync(failing, `import './dynamic-shared.ts'\nthrow new Error('failing failed')\n`)
    writeFileSync(importer, `
import { Context } from 'cordis'

const { state } = await import('./dynamic-shared.ts')

export function apply(ctx: Context) {
  ctx.on('reconcile/importer' as any, () => state)
}
`)
    const result = await ctx.hmr.reconcile({ files: [failing, importer] })

    expect(result.settledFibers).to.have.length(1)
    expect(result.importFailures).to.have.length(1)
    const { state } = await ctx.hmr.internal.import(shared, import.meta.url, {})
    expect(ctx.bail('reconcile/importer' as any)).to.equal(state)
  })

  it('restores a changed module outside every plugin with the failed unit it imports', async () => {
    await setup()
    const dep = fixture('outside-dep.ts', `export const value = 'v1'\n`)
    const outside = fixture('outside.ts', `
import { value } from './outside-dep.ts'
export const derived = value
`)
    const url = pathToFileURL(outside).href
    await ctx.hmr.internal.import(url, import.meta.url, {})
    const owner = await load('outside-owner.ts', `import './outside-dep.ts'\n` + plugin('owner', 'v1'))

    // the new module depends on an export that only the new dependency has
    writeFileSync(dep, `export const value = 'v2'\nexport const extra = '!'\n`)
    writeFileSync(outside, `
import { value, extra } from './outside-dep.ts'
export const derived = value + extra
`)
    writeFileSync(owner, `import './outside-dep.ts'\nthrow new Error('owner failed')\n`)
    const result = await ctx.hmr.reconcile({ files: [dep, outside, owner] })

    expect(result.importFailures).to.have.length(1)
    expect(result.importFailures[0].urls).to.include(url)
    const { derived } = await ctx.hmr.internal.import(url, import.meta.url, {})
    expect(derived).to.equal('v1')
  })

  it('leaves a fiber failed when the new plugin fails to apply', async () => {
    await setup()
    const path = await load('failed.ts', plugin('failed', 'v1'))

    writeFileSync(path, plugin('failed', 'v2', `throw new Error('apply failed')`))
    const result = await ctx.hmr.reconcile({ files: [path] })

    expect(result.settledFibers).to.have.length(1)
    expect(result.settledFibers[0].state).to.equal(FiberState.FAILED)
    await expect(result.settledFibers[0].await()).rejects.toThrow('apply failed')

    // the next change retries it
    writeFileSync(path, plugin('failed', 'v3'))
    const retried = await ctx.hmr.reconcile({ files: [path] })
    expect(retried.settledFibers).to.have.length(1)
    expect(ctx.bail('reconcile/failed' as any)).to.equal('v3')
  })

  it('skips a changed host module and applies the other changes', async () => {
    await setup()
    const path = await load('host.ts', plugin('host', 'v1'))
    const other = await load('other.ts', plugin('other', 'v1'))
    const url = pathToFileURL(path).href
    ctx.hmr.hostModules.add(url)

    writeFileSync(path, plugin('host', 'v2'))
    writeFileSync(other, plugin('other', 'v2'))
    const result = await ctx.hmr.reconcile({ files: [path, other] })

    expect(result.skippedHostModules).to.deep.equal([url])
    expect(ctx.bail('reconcile/host' as any)).to.equal('v1')
    expect(ctx.bail('reconcile/other' as any)).to.equal('v2')
  })

  it('skips a changed native addon', async () => {
    await setup()
    // A loaded addon is represented by its cache entry, which `require()`
    // returns without opening the file.
    const addon = fixture('addon.node', '')
    const cache = createRequire(import.meta.url).cache
    cache[addon] = { id: addon, filename: addon, loaded: true, children: [], exports: { value: 'v1' } } as any
    try {
      await load('addon-plugin.cjs', `
const { value } = require('./addon.node')
exports.apply = (ctx) => ctx.on('reconcile/addon', () => value)
`)
      expect(ctx.bail('reconcile/addon' as any)).to.equal('v1')

      const result = await ctx.hmr.reconcile({ files: [addon] })

      expect(result.skippedHostModules).to.deep.equal([pathToFileURL(addon).href])
      expect(result.importFailures).to.deep.equal([])
      expect(ctx.bail('reconcile/addon' as any)).to.equal('v1')
    } finally {
      delete cache[addon]
    }
  })

  it('replaces a plugin when a module inside a package changes', async () => {
    await setup()
    const dir = resolve(fixtureDir, 'node_modules/reconcile-shared')
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, 'package.json'), '{ "name": "reconcile-shared", "type": "module", "exports": "./index.js" }')
    writeFileSync(resolve(dir, 'index.js'), `export { value } from './lib.js'\n`)
    const lib = resolve(dir, 'lib.js')
    writeFileSync(lib, `export const value = 'v1'\n`)
    await load('package-dependent.ts', `
import { Context } from 'cordis'
import { value } from 'reconcile-shared'

export function apply(ctx: Context) {
  ctx.on('reconcile/package' as any, () => value)
}
`)
    expect(ctx.bail('reconcile/package' as any)).to.equal('v1')

    // the changed module is not imported by the plugin directly
    writeFileSync(lib, `export const value = 'v2'\n`)
    const result = await ctx.hmr.reconcile({ files: [lib] })

    expect(result.settledFibers).to.have.length(1)
    expect(ctx.bail('reconcile/package' as any)).to.equal('v2')
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

    expect(first.settledFibers).to.have.length(1)
    expect(second.settledFibers).to.have.length(1)
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

    expect(result.settledFibers).to.have.length(1)
    expect(await stats.nested).to.equal('cannot start a transaction inside another transaction')

    // once the transaction is over, its async context no longer counts
    stats.open()
    expect(await stats.later).to.equal('resolved')
  })
})
