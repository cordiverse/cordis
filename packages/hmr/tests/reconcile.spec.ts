import { Context, Fiber, FiberState } from 'cordis'
import { ModuleLoader, unwrapExports } from '@cordisjs/loader-utils'
import Loader from '@cordisjs/plugin-loader'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
