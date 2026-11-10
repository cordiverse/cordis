import { Context, Fiber, FiberState } from 'cordis'
import Loader from '@cordisjs/loader'
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Hmr from '../src/index.ts'
import { ModuleLoader } from '../src/runtime/index.ts'
import { realpathESM } from './utils.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(testDir, '__reconcile__')

// imports through Node's own loader see the module caches that HMR manages
const loader = ModuleLoader.fromInternal()!
const importModule = (specifier: string, parentURL: string) => loader.import(specifier, parentURL, {})

// Counters must survive module reloads, so they live on `globalThis`.
const stats: any = (globalThis as any).__hmrReconcile = {}

function component(name: string, value: string, body = '') {
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
  // HMR is a sibling of the loader, and at most one instance is active at a time
  let hmr: Fiber<Context> | undefined

  beforeAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
    mkdirSync(fixtureDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    await hmr?.dispose()
    hmr = undefined
    await fiber?.dispose()
    fiber = undefined
  })

  async function setup(baseUrl = import.meta.url) {
    ctx = new Context()
    fiber = await ctx.use(Loader, { baseUrl })
    hmr = await ctx.use(Hmr)
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
      fiber = ctx.use(Hmr)
      await fiber.await().catch(() => {})
    } finally {
      spy.mockRestore()
    }
    expect(fiber.state).to.equal(FiberState.FAILED)
    expect(ctx.get('hmr')).to.be.undefined
  })

  it('starts one instance at a time in a thread', async () => {
    await setup()
    const second = new Context().use(Hmr)
    await second.await().catch(() => {})
    expect(second.state).to.equal(FiberState.FAILED)

    await hmr!.dispose()
    hmr = undefined
    const third = new Context().use(Hmr)
    try {
      await third.await()
      expect(third.state).to.equal(FiberState.ACTIVE)
    } finally {
      await third.dispose()
    }
  })

  it('collects the host modules of a main entry started through a link', async () => {
    mkdirSync(resolve(fixtureDir, 'host-real'), { recursive: true })
    const main = fixture('host-real/main.mjs', `import './dep.mjs'\n`)
    const dep = fixture('host-real/dep.mjs', '')
    await importModule(pathToFileURL(main).href, import.meta.url)
    // a bin shim may be a link, through which Node loads the real path
    symlinkSync(resolve(fixtureDir, 'host-real'), resolve(fixtureDir, 'host-link'), 'junction')
    const argv = process.argv[1]
    process.argv[1] = resolve(fixtureDir, 'host-link/main.mjs')
    try {
      await setup()
    } finally {
      process.argv[1] = argv
    }
    expect([...ctx.hmr.hostModules]).to.include.members([pathToFileURL(main).href, pathToFileURL(dep).href])
  })

  it('replaces an entry component in place', async () => {
    await setup()
    const path = await load('entry.ts', component('entry', 'v1', `
  ctx.effect(() => () => stats.entryDisposed = true)`))
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === './__reconcile__/entry.ts')!
    const inner = entry.innerFiber!
    expect(ctx.bail('reconcile/entry' as any)).to.equal('v1')

    writeFileSync(path, component('entry', 'v2'))
    const result = await ctx.hmr.reconcile(() => [path])

    expect(result.settled).to.have.length(1)
    expect(result.settled[0].state).to.equal(FiberState.ACTIVE)
    expect(result.aborted).to.deep.equal([])
    expect(stats.entryDisposed).to.equal(true)
    // the entry keeps its fiber, which now runs the new component
    expect(entry.innerFiber).to.equal(inner)
    expect(Object.getPrototypeOf(inner)).to.equal(result.settled[0])
    expect(entry.disabled).to.equal(false)
    expect(ctx.bail('reconcile/entry' as any)).to.equal('v2')
  })

  it('imports a module again after it failed in an aborted attempt', async () => {
    await setup()
    const path = await load('added-entry.ts', component('added', 'v1'))
    const added = fixture('added-dep.ts', `throw new Error('added v1')\n`)
    writeFileSync(path, `import './added-dep.ts'\n` + component('added', 'v2'))
    expect((await ctx.hmr.reconcile(() => [path])).aborted).to.have.length(1)

    // only the entry is reconciled again, as the caller knows no more
    writeFileSync(added, `export {}\n`)
    const result = await ctx.hmr.reconcile(() => [path])

    expect(result.aborted).to.deep.equal([])
    expect(ctx.bail('reconcile/added' as any)).to.equal('v2')
  })

  it('imports a module again after its evaluation failed for a reason outside its file', async () => {
    await setup()
    const url = pathToFileURL(fixture('transient.mjs', `
if (!globalThis.__hmrReconcile.transientReady) throw new Error('not ready')
export const value = 'ready'
`)).href
    await expect(importModule(url, import.meta.url)).rejects.toThrow('not ready')

    stats.transientReady = true
    await ctx.hmr.reconcile(() => [])

    const { value } = await importModule(url, import.meta.url)
    expect(value).to.equal('ready')
  })

  it('keeps the job of a module when its job of another type fails', async () => {
    await setup()
    // the failing component is imported first, so that it creates the cache entry of the shared module
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
    const result = await ctx.hmr.reconcile(() => [failing, importer])

    expect(result.settled).to.have.length(1)
    expect(result.aborted).to.have.length(1)
    // the next transaction removes the failed job
    await ctx.hmr.reconcile(() => [])
    const later = await importModule(pathToFileURL(shared).href, import.meta.url)
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
    const result = await ctx.hmr.reconcile(() => [core, owner, failing, importer])

    // the importer links against the changed module of the failed owner
    expect(result.settled).to.have.length(0)
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
    await ctx.hmr.reconcile(() => [path])
    expect(ctx.get('reconcileService').value).to.equal('v2')
  })

  it('replaces a component when one of its dependencies changes', async () => {
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
    // shares an unchanged module with the dependent component, but not the changed one
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
    const result = await ctx.hmr.reconcile(() => [dep])

    expect(result.settled).to.have.length(1)
    expect(ctx.bail('reconcile/dependent' as any)).to.equal('v2')
    expect(stats.siblingApplied).to.equal(1)
  })

  it('replaces the inner fiber of an entry with an injection scope in place', async () => {
    await setup()
    ctx.provide('reconcileScope', {})
    const path = fixture('scoped.ts', component('scoped', 'v1'))
    const id = await ctx.loader.create({ name: './__reconcile__/scoped.ts', inject: ['reconcileScope'] })
    const entry = ctx.loader.store[id]!
    await ctx.loader.await()
    const outer = entry.outerFiber!
    const inner = entry.innerFiber!
    expect(outer).to.be.ok
    expect(ctx.bail('reconcile/scoped' as any)).to.equal('v1')

    writeFileSync(path, component('scoped', 'v2'))
    const result = await ctx.hmr.reconcile(() => [path])

    expect(result.settled).to.have.length(1)
    // both fibers are kept
    expect(entry.outerFiber === outer).to.equal(true)
    expect(entry.innerFiber).to.equal(inner)
    expect(Object.getPrototypeOf(inner)).to.equal(result.settled[0])
    expect(ctx.bail('reconcile/scoped' as any)).to.equal('v2')
  })

  it('replaces the components below a directory root', async () => {
    await setup()
    mkdirSync(resolve(fixtureDir, 'root'), { recursive: true })
    mkdirSync(resolve(fixtureDir, 'root-sibling'), { recursive: true })
    const dep = fixture('root/dep.ts', `export const value = 'v1'\n`)
    const dependent = (name: string, dir: string) => `
import { Context } from 'cordis'
import { value } from './${dir}/dep.ts'

export function apply(ctx: Context) {
  ctx.on('reconcile/${name}' as any, () => value)
}
`
    await load('root-dependent.ts', dependent('root', 'root'))
    // a directory whose name extends that of the root is not below it
    const siblingDep = fixture('root-sibling/dep.ts', `export const value = 'v1'\n`)
    await load('root-sibling-dependent.ts', dependent('sibling', 'root-sibling'))

    writeFileSync(dep, `export const value = 'v2'\n`)
    writeFileSync(siblingDep, `export const value = 'v2'\n`)
    const result = await ctx.hmr.reconcile(() => [resolve(fixtureDir, 'root') + sep])

    expect(result.settled).to.have.length(1)
    expect(ctx.bail('reconcile/root' as any)).to.equal('v2')
    expect(ctx.bail('reconcile/sibling' as any)).to.equal('v1')
  })

  it.each([
    ['a relative path', () => './__reconcile__/relative.ts'],
    ['a file URL', () => pathToFileURL(resolve(fixtureDir, 'relative.ts')).href],
  ])('rejects %s as a root', async (_, root) => {
    await setup()
    const path = await load('relative.ts', component('relative', 'v1'))

    writeFileSync(path, component('relative', 'v2'))
    await expect(ctx.hmr.reconcile(() => [root()])).rejects.toThrow(TypeError)
    expect(ctx.bail('reconcile/relative' as any)).to.equal('v1')
  })

  it('rejects with the error of the callback', async () => {
    await setup()
    const path = await load('callback.ts', component('callback', 'v1'))

    writeFileSync(path, component('callback', 'v2'))
    await expect(ctx.hmr.reconcile(() => {
      throw new Error('callback failed')
    })).rejects.toThrow('callback failed')
    expect(ctx.bail('reconcile/callback' as any)).to.equal('v1')
  })

  it('runs the callback inside the transaction', async () => {
    await setup()
    let open!: () => void
    const gate = new Promise<void>(resolve => open = resolve)
    const order: string[] = []
    // the nested call is wrapped, so that waiting for the callback to start does not wait for the call
    let enter!: (value: { nested: Promise<string> }) => void
    const entered = new Promise<{ nested: Promise<string> }>(resolve => enter = resolve)
    const first = ctx.hmr.reconcile(async () => {
      enter({ nested: ctx.hmr.reconcile(() => []).then(() => 'resolved', (error) => error.message) })
      await gate
      order.push('callback')
      return []
    })
    const second = ctx.hmr.reconcile(() => {
      order.push('second')
      return []
    })

    const { nested } = await entered
    expect(await nested).to.equal('cannot start a transaction inside another transaction')
    open()
    await Promise.all([first, second])
    expect(order).to.deep.equal(['callback', 'second'])
  })

  it('replaces a component that no entry manages', async () => {
    await setup()
    const path = fixture('direct.ts', component('direct', 'v1'))
    const exports = await importModule(pathToFileURL(path).href, import.meta.url)
    const direct = ctx.use(ctx.loader.unwrapExports(exports))
    await direct
    expect(ctx.bail('reconcile/direct' as any)).to.equal('v1')

    writeFileSync(path, component('direct', 'v2'))
    const result = await ctx.hmr.reconcile(() => [path])

    expect(result.settled).to.have.length(1)
    // the fiber returned by `ctx.use()` stays valid
    expect(Object.getPrototypeOf(direct)).to.equal(result.settled[0])
    expect(direct.state).to.equal(FiberState.ACTIVE)
    expect(ctx.bail('reconcile/direct' as any)).to.equal('v2')
  })

  // The `data:` module has no path, but re-importing it picks up its changed dependency.
  it('replaces a component exported from a data: URL', async () => {
    await setup()
    const path = fixture('data-impl.ts', component('data', 'v1'))
    const url = `data:text/javascript,export * from ${JSON.stringify(pathToFileURL(path).href)}`
    const exports = await importModule(url, import.meta.url)
    await ctx.use(ctx.loader.unwrapExports(exports))
    expect(ctx.bail('reconcile/data' as any)).to.equal('v1')

    writeFileSync(path, component('data', 'v2'))
    const result = await ctx.hmr.reconcile(() => [path])

    expect(result.settled).to.have.length(1)
    expect(ctx.bail('reconcile/data' as any)).to.equal('v2')
  })

  it('refreshes a disabled component for when it is enabled again', async () => {
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
    await ctx.hmr.reconcile(() => [dep])

    await ctx.loader.update(id, { disabled: false })
    await ctx.loader.store[id]!.innerFiber!.await()
    expect(ctx.bail('reconcile/disabled' as any)).to.equal('v2')
  })

  it('keeps the metadata of an entry that re-exports the changed component', async () => {
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
    const original = await importModule(entryUrl, import.meta.url)
    await ctx.use(original, {})

    writeFileSync(implementation, `
export function apply(ctx, config) {
  ctx.on('reconcile/reexport', () => ({ version: 'v2', config }))
}
`)
    const result = await ctx.hmr.reconcile(() => [implementation])

    expect(result.settled).to.have.length(1)
    expect(Object.keys(result.settled[0].inject)).to.deep.equal(['reconcileGate'])
    expect(ctx.bail('reconcile/reexport' as any)).to.deep.equal({ version: 'v2', config: { validated: true } })
    // the entry module is refreshed as well
    const refreshed = await importModule(entryUrl, import.meta.url)
    expect(refreshed.apply).to.not.equal(original.apply)
    expect(ctx.registry.get(refreshed)).to.equal(result.settled[0].runtime)
  })

  it('refreshes a module that no component depends on for its next import', async () => {
    await setup()
    const orphan = fixture('orphan.ts', 'export const value = 1\n')
    const url = pathToFileURL(orphan).href
    const before = await importModule(url, import.meta.url)
    const data = fixture('data.txt', 'data')

    writeFileSync(orphan, 'export const value = 2\n')
    const result = await ctx.hmr.reconcile(() => [orphan, data])

    expect(result.settled).to.have.length(0)
    // existing references keep the old module
    expect(before.value).to.equal(1)
    const after = await importModule(url, import.meta.url)
    expect(after.value).to.equal(2)
  })

  it('does not apply a unit whose module fails to import', async () => {
    await setup()
    const path = await load('abort.ts', component('abort', 'v1'))

    writeFileSync(path, 'export function apply(ctx {{{ BROKEN')
    const result = await ctx.hmr.reconcile(() => [path])

    expect(result.settled).to.have.length(0)
    expect(result.aborted).to.have.length(1)
    expect(result.aborted[0].urls).to.include(pathToFileURL(path).href)
    expect(ctx.bail('reconcile/abort' as any)).to.equal('v1')

    // the module cache is restored, so the next change is applied normally
    writeFileSync(path, component('abort', 'v2'))
    await ctx.hmr.reconcile(() => [path])
    expect(ctx.bail('reconcile/abort' as any)).to.equal('v2')
  })

  it('does not apply a unit whose module does not export a component', async () => {
    await setup()
    const path = await load('invalid.ts', component('invalid', 'v1', `
  ctx.effect(() => () => stats.invalidDisposed = true)`))

    writeFileSync(path, `export const apply = 'not a function'\n`)
    const result = await ctx.hmr.reconcile(() => [path])

    expect(result.aborted).to.have.length(1)
    // the running instance is not disposed
    expect(stats.invalidDisposed).to.be.undefined
    expect(ctx.bail('reconcile/invalid' as any)).to.equal('v1')
  })

  it('applies a unit when another unit fails to import', async () => {
    await setup()
    fixture('unit-common.ts', `export const value = 'common'\n`)
    const shared = (name: string, value: string) => `import './unit-common.ts'\n` + component(name, value)
    const broken = await load('unit-broken.ts', shared('broken', 'v1'))
    const healthy = await load('unit-healthy.ts', shared('healthy', 'v1'))

    // the two components only share an unchanged module
    writeFileSync(broken, 'export function apply(ctx {{{ BROKEN')
    writeFileSync(healthy, shared('healthy', 'v2'))
    const result = await ctx.hmr.reconcile(() => [broken, healthy])

    expect(result.settled).to.have.length(1)
    expect(result.aborted).to.have.length(1)
    expect(result.aborted[0].urls).to.include(pathToFileURL(broken).href)
    expect(result.aborted[0].urls).to.not.include(pathToFileURL(healthy).href)
    expect(ctx.bail('reconcile/broken' as any)).to.equal('v1')
    expect(ctx.bail('reconcile/healthy' as any)).to.equal('v2')

    // the failed unit is retried on its own
    writeFileSync(broken, shared('broken', 'v2'))
    const retried = await ctx.hmr.reconcile(() => [broken])
    expect(retried.aborted).to.deep.equal([])
    expect(ctx.bail('reconcile/broken' as any)).to.equal('v2')
  })

  it('aborts components that share a changed module together', async () => {
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
    const result = await ctx.hmr.reconcile(() => [dep, left])

    expect(result.settled).to.have.length(0)
    expect(result.aborted).to.have.length(1)
    expect(result.aborted[0].urls).to.include(pathToFileURL(dep).href)
    expect(ctx.bail('reconcile/left' as any)).to.equal('v1')
    expect(ctx.bail('reconcile/right' as any)).to.equal('v1')
  })

  it('aborts a component that newly imports a changed module of a failed unit', async () => {
    await setup()
    const dep = fixture('adopt-dep.ts', `export const value = 'v1'\n`)
    const owner = await load('adopt-owner.ts', `import './adopt-dep.ts'\n` + component('owner', 'v1'))
    const adopter = await load('adopt-adopter.ts', component('adopter', 'v1'))

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
    const result = await ctx.hmr.reconcile(() => [dep, owner, adopter])

    expect(result.settled).to.have.length(0)
    expect(result.aborted).to.have.length(1)
    expect(result.aborted[0].urls).to.include.members([
      pathToFileURL(dep).href,
      pathToFileURL(adopter).href,
    ])
    expect(ctx.bail('reconcile/owner' as any)).to.equal('v1')
    expect(ctx.bail('reconcile/adopter' as any)).to.equal('v1')
  })

  it('shares a module first loaded by a failed unit with a unit that imports it dynamically', async () => {
    await setup()
    const failing = await load('dynamic-failing.ts', component('failing', 'v1'))
    const importer = await load('dynamic-importer.ts', component('importer', 'v1'))
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
    const result = await ctx.hmr.reconcile(() => [failing, importer])

    expect(result.settled).to.have.length(1)
    expect(result.aborted).to.have.length(1)
    const { state } = await importModule(shared, import.meta.url)
    expect(ctx.bail('reconcile/importer' as any)).to.equal(state)
  })

  it('restores a changed module outside every component with the failed unit it imports', async () => {
    await setup()
    const dep = fixture('outside-dep.ts', `export const value = 'v1'\n`)
    const outside = fixture('outside.ts', `
import { value } from './outside-dep.ts'
export const derived = value
`)
    const url = pathToFileURL(outside).href
    await importModule(url, import.meta.url)
    const owner = await load('outside-owner.ts', `import './outside-dep.ts'\n` + component('owner', 'v1'))

    // the new module depends on an export that only the new dependency has
    writeFileSync(dep, `export const value = 'v2'\nexport const extra = '!'\n`)
    writeFileSync(outside, `
import { value, extra } from './outside-dep.ts'
export const derived = value + extra
`)
    writeFileSync(owner, `import './outside-dep.ts'\nthrow new Error('owner failed')\n`)
    const result = await ctx.hmr.reconcile(() => [dep, outside, owner])

    expect(result.aborted).to.have.length(1)
    expect(result.aborted[0].urls).to.include(url)
    const { derived } = await importModule(url, import.meta.url)
    expect(derived).to.equal('v1')
  })

  it('leaves a fiber failed when the new component fails to apply', async () => {
    await setup()
    const path = await load('failed.ts', component('failed', 'v1'))

    writeFileSync(path, component('failed', 'v2', `throw new Error('apply failed')`))
    const result = await ctx.hmr.reconcile(() => [path])

    expect(result.settled).to.have.length(1)
    expect(result.settled[0].state).to.equal(FiberState.FAILED)
    await expect(result.settled[0].await()).rejects.toThrow('apply failed')

    // the next change retries it
    writeFileSync(path, component('failed', 'v3'))
    const retried = await ctx.hmr.reconcile(() => [path])
    expect(retried.settled).to.have.length(1)
    expect(ctx.bail('reconcile/failed' as any)).to.equal('v3')
  })

  it('skips a changed host module below a root and applies the other changes', async () => {
    await setup()
    mkdirSync(resolve(fixtureDir, 'host'), { recursive: true })
    const path = await load('host/host.ts', component('host', 'v1'))
    const other = await load('host/other.ts', component('other', 'v1'))
    const url = pathToFileURL(path).href
    ctx.hmr.hostModules.add(url)

    writeFileSync(path, component('host', 'v2'))
    writeFileSync(other, component('other', 'v2'))
    const result = await ctx.hmr.reconcile(() => [resolve(fixtureDir, 'host')])

    expect(result.skipped).to.deep.equal([{ urls: [url], reason: Hmr.SkipReason.HostModule }])
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
      await load('addon-component.cjs', `
const { value } = require('./addon.node')
exports.apply = (ctx) => ctx.on('reconcile/addon', () => value)
`)
      expect(ctx.bail('reconcile/addon' as any)).to.equal('v1')

      const result = await ctx.hmr.reconcile(() => [addon])

      expect(result.skipped).to.deep.equal([{ urls: [pathToFileURL(addon).href], reason: Hmr.SkipReason.NativeAddon }])
      expect(result.aborted).to.deep.equal([])
      expect(ctx.bail('reconcile/addon' as any)).to.equal('v1')
    } finally {
      delete cache[addon]
    }
  })

  it('replaces a component when a module inside a package changes', async () => {
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

    // the changed module is not imported by the component directly
    writeFileSync(lib, `export const value = 'v2'\n`)
    const result = await ctx.hmr.reconcile(() => [lib])

    expect(result.settled).to.have.length(1)
    expect(ctx.bail('reconcile/package' as any)).to.equal('v2')
  })

  it('replaces a component whose nested dependency is removed in favor of a hoisted copy', async () => {
    await setup()
    const install = (dir: string, value: string) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, 'package.json'), '{ "name": "reconcile-hoisted", "main": "index.cjs" }')
      writeFileSync(resolve(dir, 'index.cjs'), `exports.value = '${value}'\n`)
    }
    install(resolve(fixtureDir, 'node_modules/reconcile-hoisted'), 'hoisted')
    const nested = resolve(fixtureDir, 'hoist/node_modules/reconcile-hoisted')
    install(nested, 'nested')
    await load('hoist/index.cjs', `
const { value } = require('reconcile-hoisted')
exports.apply = (ctx) => ctx.on('reconcile/hoisted', () => value)
`)
    expect(ctx.bail('reconcile/hoisted' as any)).to.equal('nested')

    rmSync(nested, { recursive: true })
    const result = await ctx.hmr.reconcile(() => [nested])

    expect(result.aborted).to.deep.equal([])
    expect(result.settled).to.have.length(1)
    expect(ctx.bail('reconcile/hoisted' as any)).to.equal('hoisted')
  })

  describe('a component package', () => {
    const name = (value: string) => `export const apply = ctx => ctx.on('reconcile/moved', () => '${value}')\n`

    /** Write a package of the given files below `__reconcile__`. */
    function install(path: string, files: Record<string, string>) {
      const dir = resolve(fixtureDir, path)
      mkdirSync(dir, { recursive: true })
      for (const [file, content] of Object.entries(files)) writeFileSync(resolve(dir, file), content)
      return dir
    }

    /** Link `<from>/node_modules/<name>` to `<target>`, as an isolated layout does. */
    function link(from: string, target: string) {
      const location = resolve(fixtureDir, from, 'node_modules/reconcile-linked')
      mkdirSync(dirname(location), { recursive: true })
      try {
        unlinkSync(location)
      } catch {}
      symlinkSync(resolve(fixtureDir, target), location, 'junction')
      return location
    }

    const linked = (value: string) => ({
      'package.json': '{ "name": "reconcile-linked", "type": "module", "exports": "./index.mjs" }',
      'index.mjs': name(value),
    })

    type Field = 'exports' | 'main'

    const entry = (pkg: string, file: string, field: Field = 'exports', extra = {}) => {
      return JSON.stringify({ name: pkg, type: 'module', [field]: `./${file}`, ...extra })
    }

    /** Load a component package `<pkg>` whose manifest points `field` to `a.mjs`. */
    async function loadEntry(pkg: string, field: Field = 'exports') {
      await setup(pathToFileURL(fixtureDir + sep).href)
      const dir = install(`node_modules/${pkg}`, { 'package.json': entry(pkg, 'a.mjs', field), 'a.mjs': name('a1') })
      const id = await ctx.loader.create({ name: pkg })
      await ctx.loader.store[id]!.innerFiber!.await()
      expect(ctx.bail('reconcile/moved' as any)).to.equal('a1')
      return dir
    }

    it.each(['exports', 'main'] as const)('replaces it with the module that its `%s` newly points to', async (field) => {
      const pkg = `reconcile-${field}`
      const dir = await loadEntry(pkg, field)
      // the previous entry changes too, so that importing it would also replace the component
      install(`node_modules/${pkg}`, { 'package.json': entry(pkg, 'b.mjs', field), 'a.mjs': name('a2'), 'b.mjs': name('b') })
      const result = await ctx.hmr.reconcile(() => [dir])

      expect(result.settled).to.have.length(1)
      expect(ctx.bail('reconcile/moved' as any)).to.equal('b')
    })

    it('replaces it with the module that it newly exports in place of a removed one', async () => {
      const dir = await loadEntry('reconcile-removed')
      install('node_modules/reconcile-removed', { 'package.json': entry('reconcile-removed', 'b.mjs'), 'b.mjs': name('b') })
      rmSync(resolve(dir, 'a.mjs'))
      const result = await ctx.hmr.reconcile(() => [dir])

      expect(result.aborted).to.deep.equal([])
      expect(result.settled).to.have.length(1)
      expect(ctx.bail('reconcile/moved' as any)).to.equal('b')
    })

    it('replaces it with the module that it newly exports after a transaction that only changes its manifest', async () => {
      const dir = await loadEntry('reconcile-metadata')
      writeFileSync(resolve(dir, 'package.json'), entry('reconcile-metadata', 'a.mjs', 'exports', { description: 'v2' }))
      await ctx.hmr.reconcile(() => [resolve(dir, 'package.json')])

      install('node_modules/reconcile-metadata', { 'package.json': entry('reconcile-metadata', 'b.mjs'), 'a.mjs': name('a2'), 'b.mjs': name('b') })
      const result = await ctx.hmr.reconcile(() => [dir])

      expect(result.settled).to.have.length(1)
      expect(ctx.bail('reconcile/moved' as any)).to.equal('b')
    })

    it('replaces it given only its manifest and the module that it newly exports', async () => {
      const dir = await loadEntry('reconcile-manifest')
      install('node_modules/reconcile-manifest', { 'package.json': entry('reconcile-manifest', 'b.mjs'), 'b.mjs': name('b') })
      const result = await ctx.hmr.reconcile(() => [resolve(dir, 'package.json'), resolve(dir, 'b.mjs')])

      expect(result.settled).to.have.length(1)
      expect(ctx.bail('reconcile/moved' as any)).to.equal('b')
    })

    it('replaces it with the module that it newly exports once that module is fixed, also after HMR restarts', async () => {
      const dir = await loadEntry('reconcile-retry')
      install('node_modules/reconcile-retry', { 'package.json': entry('reconcile-retry', 'b.mjs'), 'b.mjs': `throw new Error('broken')\n` })
      const first = await ctx.hmr.reconcile(() => [dir])
      expect(first.aborted).to.have.length(1)
      expect(ctx.bail('reconcile/moved' as any)).to.equal('a1')

      await hmr!.dispose()
      hmr = await ctx.use(Hmr)
      install('node_modules/reconcile-retry', { 'b.mjs': name('b') })
      // the retry includes the change that moved the entry
      const result = await ctx.hmr.reconcile(() => [resolve(dir, 'package.json'), resolve(dir, 'b.mjs')])

      expect(result.aborted).to.deep.equal([])
      expect(result.settled).to.have.length(1)
      expect(ctx.bail('reconcile/moved' as any)).to.equal('b')
    })

    it('aborts it with a component that imports a module that its new entry newly imports', async () => {
      const dir = await loadEntry('reconcile-joined')
      const shared = fixture('joined-shared.mjs', `export const value = 'v1'\n`)
      const other = fixture('joined-other.mjs', `
import { value } from './joined-shared.mjs'
export const apply = ctx => ctx.on('reconcile/joined', () => value)
`)
      const id = await ctx.loader.create({ name: './joined-other.mjs' })
      await ctx.loader.store[id]!.innerFiber!.await()

      install('node_modules/reconcile-joined', {
        'package.json': entry('reconcile-joined', 'b.mjs'),
        'b.mjs': `import { value } from '../../joined-shared.mjs'\nexport const apply = ctx => ctx.on('reconcile/moved', () => value)\n`,
      })
      writeFileSync(shared, `export const value = 'v2'\n`)
      writeFileSync(other, `import './joined-shared.mjs'\nthrow new Error('broken')\n`)
      const result = await ctx.hmr.reconcile(() => [dir, shared, other])

      // the closures of both components share the evicted module in the new module graph
      expect(result.aborted).to.have.length(1)
      expect(result.settled).to.have.length(0)
      expect(ctx.bail('reconcile/moved' as any)).to.equal('a1')
      expect(ctx.bail('reconcile/joined' as any)).to.equal('v1')
      expect((await importModule(pathToFileURL(shared).href, import.meta.url) as any).value).to.equal('v1')
    })

    it.runIf(realpathESM)('replaces it with the version that a retargeted link selects', async () => {
      await setup(pathToFileURL(fixtureDir + sep).href)
      install('store/linked@1', linked('v1'))
      install('store/linked@2', linked('v2'))
      const location = link('.', 'store/linked@1')
      const id = await ctx.loader.create({ name: 'reconcile-linked' })
      await ctx.loader.store[id]!.innerFiber!.await()
      expect(ctx.bail('reconcile/moved' as any)).to.equal('v1')

      // the previous version stays installed, as when another package uses it
      link('.', 'store/linked@2')
      const result = await ctx.hmr.reconcile(() => [location, resolve(fixtureDir, 'store/linked@1')])

      expect(result.settled).to.have.length(1)
      expect(ctx.bail('reconcile/moved' as any)).to.equal('v2')
    })

    it.runIf(realpathESM)('keeps it when its imports now resolve to different versions', async () => {
      await setup()
      install('store/linked@1', linked('v1'))
      install('store/linked@2', linked('v2'))
      const location = link('dual-a', 'store/linked@1')
      link('dual-b', 'store/linked@1')
      const parent = (dir: string) => pathToFileURL(resolve(fixtureDir, dir) + sep).href
      const exports = await importModule('reconcile-linked', parent('dual-a'))
      expect(await importModule('reconcile-linked', parent('dual-b'))).to.equal(exports)
      await ctx.use(ctx.loader.unwrapExports(exports))

      link('dual-a', 'store/linked@2')
      const result = await ctx.hmr.reconcile(() => [location, resolve(fixtureDir, 'store/linked@1')])

      // the fibers of the component do not record which import each comes from
      expect(result.aborted).to.deep.equal([])
      expect(result.skipped.map(skip => skip.reason)).to.deep.equal([Hmr.SkipReason.AmbiguousImport])
      expect(ctx.bail('reconcile/moved' as any)).to.equal('v1')
    })
  })

  describe('a package added below the importer', () => {
    /** A package `<name>` that exports `value`, hoisted to `__reconcile__/node_modules` or below `<dir>`. */
    function install(name: string, dir: string, value: string, ext: 'mjs' | 'cjs') {
      const path = resolve(fixtureDir, dir, 'node_modules', name)
      mkdirSync(path, { recursive: true })
      const manifest = ext === 'mjs' ? { name, type: 'module', exports: './index.mjs' } : { name, main: 'index.cjs' }
      writeFileSync(resolve(path, 'package.json'), JSON.stringify(manifest))
      writeFileSync(resolve(path, `index.${ext}`), ext === 'mjs' ? `export const value = '${value}'\n` : `exports.value = '${value}'\n`)
      return path
    }

    it('replaces a component that imports it', async () => {
      await setup()
      install('reconcile-shadow-esm', '.', 'hoisted', 'mjs')
      mkdirSync(resolve(fixtureDir, 'shadow-esm'), { recursive: true })
      await load('shadow-esm/component.mjs', `
import { value } from 'reconcile-shadow-esm'
export const apply = ctx => ctx.on('reconcile/shadow-esm', () => value)
`)
      expect(ctx.bail('reconcile/shadow-esm' as any)).to.equal('hoisted')

      const location = install('reconcile-shadow-esm', 'shadow-esm', 'nested', 'mjs')
      const result = await ctx.hmr.reconcile(() => [location])

      expect(result.settled).to.have.length(1)
      expect(ctx.bail('reconcile/shadow-esm' as any)).to.equal('nested')
    })

    it.each([
      ['location', (location: string) => location],
      ['manifest', (location: string) => resolve(location, 'package.json')],
    ])('replaces a component that requires it, given its %s', async (kind, root) => {
      const name = `reconcile-shadow-${kind}`
      await setup()
      install(name, '.', 'hoisted', 'cjs')
      mkdirSync(resolve(fixtureDir, name), { recursive: true })
      await load(`${name}/component.cjs`, `
const { value } = require('${name}')
exports.apply = ctx => ctx.on('reconcile/${name}', () => value)
`)
      expect(ctx.bail(`reconcile/${name}` as any)).to.equal('hoisted')

      const location = install(name, name, 'nested', 'cjs')
      const result = await ctx.hmr.reconcile(() => [root(location)])

      expect(result.settled).to.have.length(1)
      expect(ctx.bail(`reconcile/${name}` as any)).to.equal('nested')
    })
  })

  it('skips a component whose exporting modules now export different components', async () => {
    await setup()
    const impl = (value: string) => `export default { apply: ctx => ctx.on('reconcile/split', () => '${value}') }\n`
    const path = fixture('split-impl.mjs', impl('v1'))
    await load('split-a.mjs', `export { default } from './split-impl.mjs'\n`)
    const other = await load('split-b.mjs', `export { default } from './split-impl.mjs'\n`)
    expect(ctx.bail('reconcile/split' as any)).to.equal('v1')

    writeFileSync(path, impl('v2'))
    writeFileSync(other, impl('other'))
    const result = await ctx.hmr.reconcile(() => [path, other])

    // the fibers of the component do not record which module each comes from
    expect(result.settled).to.have.length(0)
    expect(result.skipped.map(skip => skip.reason)).to.deep.equal([Hmr.SkipReason.AmbiguousExport])
    expect(ctx.bail('reconcile/split' as any)).to.equal('v1')
  })

  it('replaces a component that only require() has loaded when its dependency changes', async () => {
    await setup()
    const dep = fixture('required-dep.cjs', `exports.value = 'v1'\n`)
    const path = fixture('required.cjs', `
const { value } = require('./required-dep.cjs')
exports.apply = ctx => ctx.on('reconcile/required', () => value)
`)
    await ctx.use(createRequire(import.meta.url)(path))
    expect(ctx.bail('reconcile/required' as any)).to.equal('v1')

    writeFileSync(dep, `exports.value = 'v2'\n`)
    const result = await ctx.hmr.reconcile(() => [dep])

    expect(result.settled).to.have.length(1)
    expect(ctx.bail('reconcile/required' as any)).to.equal('v2')
  })

  it('runs transactions one at a time', async () => {
    await setup()
    const slow = await load('queue-slow.ts', component('slow', 'v1'))
    const fast = await load('queue-fast.ts', component('fast', 'v1'))

    writeFileSync(slow, component('slow', 'v2', `
  await new Promise(resolve => setTimeout(resolve, 300))
  stats.slowDone = performance.now()`))
    writeFileSync(fast, component('fast', 'v2', `stats.fastApplied = performance.now()`))
    const [first, second] = await Promise.all([
      ctx.hmr.reconcile(() => [slow]),
      ctx.hmr.reconcile(() => [fast]),
    ])

    expect(first.settled).to.have.length(1)
    expect(second.settled).to.have.length(1)
    expect(stats.fastApplied).to.be.greaterThanOrEqual(stats.slowDone)
  })

  it('rejects a transaction started inside another one', async () => {
    await setup()
    const body = `
  stats.nested = ctx.hmr.reconcile(() => []).then(() => 'resolved', (error) => error.message)
  // a promise reaction keeps the async context it was created in
  stats.later = new Promise(resolve => stats.open = resolve)
    .then(() => ctx.hmr.reconcile(() => []))
    .then(() => 'resolved', (error) => error.message)`
    const path = await load('nested.ts', component('nested', 'v1', body).replace(
      `export const name`,
      `export const inject = ['hmr']\n\nexport const name`,
    ))
    expect(await stats.nested).to.equal('resolved')

    writeFileSync(path, component('nested', 'v2', body).replace(
      `export const name`,
      `export const inject = ['hmr']\n\nexport const name`,
    ))
    const result = await ctx.hmr.reconcile(() => [path])

    expect(result.settled).to.have.length(1)
    expect(await stats.nested).to.equal('cannot start a transaction inside another transaction')

    // once the transaction is over, its async context no longer counts
    stats.open()
    expect(await stats.later).to.equal('resolved')
  })
})
