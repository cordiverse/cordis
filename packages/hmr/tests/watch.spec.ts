import { Context, Fiber, Service } from 'cordis'
import Loader from '@cordisjs/loader'
import Fs, { WatchOptions } from '@cordisjs/fs'
import NodeFs from '@cordisjs/fs-node'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { format } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest'
import Hmr from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(testDir, '__watch__')

function component(name: string, value: string) {
  return `
import { Context } from 'cordis'

export const name = '${name}'

export function apply(ctx: Context) {
  ctx.on('hmr-watch/${name}' as any, () => '${value}')
}
`
}

interface Watch {
  path: string
  options?: WatchOptions
  listeners: ((url: URL) => void)[]
}

// stands in for `@cordisjs/fs-node`, so that changes are reported by hand
class FakeFs extends Service {
  static watches: Watch[] = []

  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  watch(url: URL, options?: WatchOptions) {
    const watch: Watch = { path: fileURLToPath(url), options, listeners: [] }
    FakeFs.watches.push(watch)
    return {
      on: (name: string, listener: (url: URL) => void) => {
        if (name === 'change') watch.listeners.push(listener)
        return () => {}
      },
    }
  }
}

function change(filename: string) {
  for (const { path, listeners } of FakeFs.watches) {
    if (!filename.startsWith(path)) continue
    for (const listener of listeners) listener(pathToFileURL(filename))
  }
}

describe('Hmr with fs', () => {
  let ctx: Context
  let fiber: Fiber | undefined
  // HMR is a sibling of the loader, and at most one instance is active at a time
  let hmr: Fiber | undefined
  let reconcile: MockInstance<Hmr['reconcile']>

  beforeEach(() => {
    reconcile = vi.spyOn(Hmr.prototype, 'reconcile')
  })

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
    FakeFs.watches = []
    reconcile.mockRestore()
  })

  async function setup(config: Partial<Hmr.WatchConfig> = {}, base?: string, baseUrl = import.meta.url) {
    ctx = new Context()
    ctx.baseUrl = baseUrl
    fiber = await ctx.use(Loader)
    await ctx.use(FakeFs)
    hmr = await ctx.use(Hmr, { base, watch: { enabled: true, debounce: 50, ...config } } as Hmr.Config)
  }

  async function load(name: string, content: string) {
    const path = resolve(fixtureDir, name)
    writeFileSync(path, content)
    const id = await ctx.loader.create({ name: `./__watch__/${name}` })
    await ctx.loader.store[id]!.innerFiber!.await()
    return path
  }

  async function nextReload(index = reconcile.mock.results.length) {
    await vi.waitFor(() => expect(reconcile.mock.results.length).to.be.greaterThan(index))
    return reconcile.mock.results[index].value as Promise<Hmr.Result>
  }

  // Only `baseDir` is asserted, so nothing is watched.
  describe('base', () => {
    async function create(base?: string, baseUrl: string | null = import.meta.url) {
      ctx = new Context()
      ctx.baseUrl = baseUrl ?? undefined
      fiber = await ctx.use(Hmr, { base } as Hmr.Config)
      // a trailing separator does not matter
      return resolve(ctx.hmr.baseDir)
    }

    // An absolute `base` is a legal configuration, but `new URL()` reads a Windows
    // drive letter as a URL scheme (`c:`) and `fileURLToPath` rejects that scheme.
    it.runIf(process.platform === 'win32')('accepts a drive-letter base', async () => {
      expect(await create(testDir + sep)).to.equal(testDir)
    })

    it('resolves a relative base against the context', async () => {
      expect(await create('..')).to.equal(dirname(testDir))
    })

    it('defaults to the context directory', async () => {
      expect(await create()).to.equal(testDir)
    })

    it('defaults to the working directory without a context directory', async () => {
      expect(await create(undefined, null)).to.equal(process.cwd())
    })

    const basePath = resolve(testDir, 'base with spaces # %')
    it.each([
      ['relative path', '../hmr base', resolve('../hmr base')],
      ['absolute path', basePath, basePath],
      ['file URL', pathToFileURL(basePath).href, basePath],
    ])('accepts a %s without a context directory', async (_, base, expected) => {
      expect(await create(base, null)).to.equal(expected)
    })
  })

  it('watches `files` in `base`', async () => {
    const files = ['src', '!**/.*']
    await setup({ files }, '__watch__')
    expect(FakeFs.watches.map(({ path, options }) => [path, options?.filter])).to.deep.equal([[fixtureDir, files]])
  })

  it('does not watch with empty `files`', async () => {
    await setup({ files: [] })
    expect(FakeFs.watches).to.deep.equal([])
  })

  it('reconciles the changes of one debounce window as a batch', async () => {
    await setup()
    const a = await load('batch-a.ts', component('a', 'v1'))
    const b = await load('batch-b.ts', component('b', 'v1'))

    const reloaded = nextReload()
    writeFileSync(a, component('a', 'v2'))
    writeFileSync(b, component('b', 'v2'))
    change(a)
    change(b)
    const result = await reloaded

    expect(result.settled).to.have.length(2)
    expect(ctx.bail('hmr-watch/a' as any)).to.equal('v2')
    expect(ctx.bail('hmr-watch/b' as any)).to.equal('v2')
    await new Promise(r => setTimeout(r, 100))
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it('retries the changes of a failed batch with the next one', async () => {
    await setup()
    const dep = resolve(fixtureDir, 'retry-dep.ts')
    writeFileSync(dep, `export const value = 'v1'\n`)
    const dependent = (body: string) => `
import { Context } from 'cordis'
import { value } from './retry-dep.ts'

${body}
`
    const path = await load('retry.ts', dependent(`export function apply(ctx: Context) {
  ctx.on('hmr-watch/retry' as any, () => value)
}`))

    // one window: the dependency changes, but the component no longer exports one
    writeFileSync(dep, `export const value = 'v2'\n`)
    writeFileSync(path, dependent(`export const apply = 'not a function'`))
    let reloaded = nextReload()
    change(dep)
    change(path)
    expect((await reloaded).aborted).to.have.length(1)
    expect(ctx.bail('hmr-watch/retry' as any)).to.equal('v1')

    // the next window only repairs the component
    writeFileSync(path, dependent(`export function apply(ctx: Context) {
  ctx.on('hmr-watch/retry' as any, () => value)
}`))
    reloaded = nextReload()
    change(path)
    await reloaded
    expect(ctx.bail('hmr-watch/retry' as any)).to.equal('v2')
  })

  it('retries the changes of a failed batch with a batch queued behind it', async () => {
    await setup()
    const dep = resolve(fixtureDir, 'queued-dep.ts')
    writeFileSync(dep, `export const value = 'v1'\n`)
    const dependent = (body: string) => `
import { Context } from 'cordis'
import { value } from './queued-dep.ts'

${body}
`
    const valid = dependent(`export function apply(ctx: Context) {
  ctx.on('hmr-watch/queued' as any, () => value)
}`)
    const path = await load('queued.ts', valid)

    // the first batch holds while importing the component, and then fails
    let release!: () => void
    const gate = (globalThis as any).__hmrWatchGate = { entered: false, hold: new Promise<void>(r => release = r) }
    writeFileSync(dep, `export const value = 'v2'\n`)
    writeFileSync(path, dependent(`const gate = (globalThis as any).__hmrWatchGate
gate.entered = true
await gate.hold
export const apply = 'not a function'`))
    const first = nextReload()
    change(dep)
    change(path)
    await vi.waitFor(() => expect(gate.entered).to.equal(true))

    // the repair arrives while the first batch is still running
    writeFileSync(path, valid)
    const second = nextReload(1)
    change(path)
    await new Promise(r => setTimeout(r, 150))
    release()

    expect((await first).aborted).to.have.length(1)
    await second
    expect(ctx.bail('hmr-watch/queued' as any)).to.equal('v2')
  })

  it('retries an entry that a manifest has moved with the next batch', async () => {
    await setup({}, undefined, pathToFileURL(fixtureDir + sep).href)
    const dir = resolve(fixtureDir, 'node_modules/hmr-watch-entry')
    mkdirSync(dir, { recursive: true })
    const manifest = resolve(dir, 'package.json')
    const entry = resolve(dir, 'b.mjs')
    const exports = (file: string) => JSON.stringify({ name: 'hmr-watch-entry', type: 'module', exports: `./${file}` })
    const apply = (value: string) => `export const apply = ctx => ctx.on('hmr-watch/entry', () => '${value}')\n`
    writeFileSync(manifest, exports('a.mjs'))
    writeFileSync(resolve(dir, 'a.mjs'), apply('a'))
    const id = await ctx.loader.create({ name: 'hmr-watch-entry' })
    await ctx.loader.store[id]!.innerFiber!.await()

    // one window: the manifest moves the entry to a module that fails
    writeFileSync(manifest, exports('b.mjs'))
    writeFileSync(entry, `throw new Error('broken')\n`)
    let reloaded = nextReload()
    change(manifest)
    change(entry)
    expect((await reloaded).aborted).to.have.length(1)
    expect(ctx.bail('hmr-watch/entry' as any)).to.equal('a')

    // the next window only repairs the new entry
    writeFileSync(entry, apply('b'))
    reloaded = nextReload()
    change(entry)
    await reloaded
    expect(ctx.bail('hmr-watch/entry' as any)).to.equal('b')
  })

  it('retries an importer of a package that a nearer package shadows with the next batch', async () => {
    await setup({}, undefined, pathToFileURL(fixtureDir + sep).href)
    const install = (dir: string, source: string) => {
      const path = resolve(fixtureDir, dir, 'node_modules/hmr-watch-dep')
      mkdirSync(path, { recursive: true })
      writeFileSync(resolve(path, 'package.json'), '{ "name": "hmr-watch-dep", "type": "module", "exports": "./index.mjs" }')
      writeFileSync(resolve(path, 'index.mjs'), source)
      return path
    }
    install('.', `export const value = 'hoisted'\n`)
    mkdirSync(resolve(fixtureDir, 'shadow'), { recursive: true })
    writeFileSync(resolve(fixtureDir, 'shadow/component.mjs'), `
import { value } from 'hmr-watch-dep'
export const apply = ctx => ctx.on('hmr-watch/shadow', () => value)
`)
    const id = await ctx.loader.create({ name: './shadow/component.mjs' })
    await ctx.loader.store[id]!.innerFiber!.await()
    expect(ctx.bail('hmr-watch/shadow' as any)).to.equal('hoisted')

    // one window: a nearer package is added, whose entry fails
    const dir = install('shadow', `throw new Error('broken')\n`)
    let reloaded = nextReload()
    change(resolve(dir, 'package.json'))
    change(resolve(dir, 'index.mjs'))
    expect((await reloaded).aborted).to.have.length(1)
    expect(ctx.bail('hmr-watch/shadow' as any)).to.equal('hoisted')

    // the next window only repairs its entry
    writeFileSync(resolve(dir, 'index.mjs'), `export const value = 'nested'\n`)
    reloaded = nextReload()
    change(resolve(dir, 'index.mjs'))
    await reloaded
    expect(ctx.bail('hmr-watch/shadow' as any)).to.equal('nested')
  })

  it('only reports a change to a host module', async () => {
    await setup()
    const path = await load('host.ts', component('host', 'v1'))
    ctx.hmr.hostModules.add(pathToFileURL(path).href)
    const warnings: string[] = []
    ctx.logger.exporter({
      export(message) {
        if (message.type === 'warn') warnings.push(format(...message.args))
      },
    })

    const reloaded = nextReload()
    writeFileSync(path, component('host', 'v2'))
    change(path)
    await reloaded
    await vi.waitFor(() => expect(warnings.some(warning => warning.includes('host.ts'))).to.equal(true))
    expect(ctx.bail('hmr-watch/host' as any)).to.equal('v1')
  })

  it('reloads a component when its file changes on disk', async () => {
    ctx = new Context()
    ctx.baseUrl = import.meta.url
    fiber = await ctx.use(Loader)
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    hmr = await ctx.use(Hmr, { watch: { enabled: true, files: ['__watch__'], debounce: 50 } })
    const path = await load('disk.ts', component('disk', 'v1'))

    // some platforms report changes late, so the file is rewritten until one is seen
    await vi.waitFor(() => {
      writeFileSync(path, component('disk', 'v2'))
      expect(ctx.bail('hmr-watch/disk' as any)).to.equal('v2')
    }, { timeout: 5000, interval: 200 })
  })
})
