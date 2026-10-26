import { Context, Fiber, Service } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Fs, { WatchCallback, WatchOptions } from '@cordisjs/plugin-fs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { format } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest'
import Hmr from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(testDir, '__watch__')

function plugin(name: string, value: string) {
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
  callback: WatchCallback
  options?: WatchOptions
}

// stands in for `@cordisjs/plugin-fs`, so that changes are reported by hand
class FakeFs extends Service {
  static watches: Watch[] = []

  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  watch(path: string, callback: WatchCallback, options?: WatchOptions) {
    FakeFs.watches.push({ path, callback, options })
    return () => {}
  }
}

function change(filename: string) {
  for (const { path, callback, options } of FakeFs.watches) {
    if (!filename.startsWith(path) || options?.ignored?.(filename)) continue
    callback(filename)
  }
}

describe('Hmr with fs', () => {
  let ctx: Context
  let fiber: Fiber<Context> | undefined
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
    await fiber?.dispose()
    fiber = undefined
    FakeFs.watches = []
    reconcile.mockRestore()
  })

  async function setup(config: Partial<Hmr.WatchConfig> = {}, base?: string) {
    ctx = new Context()
    ctx.baseUrl = import.meta.url
    fiber = await ctx.plugin(Loader)
    await ctx.plugin(FakeFs)
    await ctx.plugin(Hmr, { base, watch: { enabled: true, debounce: 50, ...config } })
  }

  async function load(name: string, content: string) {
    const path = resolve(fixtureDir, name)
    writeFileSync(path, content)
    const id = await ctx.loader.create({ name: `./__watch__/${name}` })
    await ctx.loader.store[id]!.innerFiber!.await()
    return path
  }

  async function nextReload() {
    const index = reconcile.mock.results.length
    await vi.waitFor(() => expect(reconcile.mock.results.length).to.be.greaterThan(index))
    return reconcile.mock.results[index].value as Promise<Hmr.Result>
  }

  // Only `baseDir` is asserted, so nothing is watched.
  describe('base', () => {
    async function create(base?: string, baseUrl: string | null = import.meta.url) {
      ctx = new Context()
      ctx.baseUrl = baseUrl ?? undefined
      fiber = await ctx.plugin(Hmr, { base })
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

  it('watches each root relative to `base`', async () => {
    await setup({}, '__watch__')
    expect(FakeFs.watches.map(watch => watch.path)).to.deep.equal([fixtureDir])
  })

  it('watches each root relative to the context', async () => {
    await setup({ root: ['.', '__watch__'] })
    expect(FakeFs.watches.map(watch => watch.path)).to.deep.equal([testDir, fixtureDir])
  })

  it('does not watch without a root', async () => {
    await setup({ root: [] })
    expect(FakeFs.watches).to.deep.equal([])
  })

  // `ignored` is matched against `path.relative()`, which is backslash-separated
  // on Windows. Only a top-level entry carries no separator, so a nested
  // `node_modules` was not ignored there. Directories are tested before they
  // are descended into, so the directory itself has to match.
  it('ignores nested matches of `ignored`', async () => {
    await setup()
    const [{ options }] = FakeFs.watches
    expect(options!.ignored!(resolve(testDir, 'packages/core/node_modules'))).to.equal(true)
    expect(options!.ignored!(resolve(testDir, 'src/.hidden'))).to.equal(true)
    expect(options!.ignored!(resolve(testDir, 'src/index.js'))).to.equal(false)
  })

  it('reconciles the changes of one debounce window as a batch', async () => {
    await setup()
    const a = await load('batch-a.ts', plugin('a', 'v1'))
    const b = await load('batch-b.ts', plugin('b', 'v1'))

    const reloaded = nextReload()
    writeFileSync(a, plugin('a', 'v2'))
    writeFileSync(b, plugin('b', 'v2'))
    change(a)
    change(b)
    const result = await reloaded as Hmr.Result.Finished

    expect(result.status).to.equal('finished')
    expect(result.fibers).to.have.length(2)
    expect(ctx.bail('hmr-watch/a' as any)).to.equal('v2')
    expect(ctx.bail('hmr-watch/b' as any)).to.equal('v2')
    await new Promise(r => setTimeout(r, 100))
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it('only reports a change to a host module', async () => {
    await setup()
    const path = await load('host.ts', plugin('host', 'v1'))
    ctx.hmr.hostModules.add(pathToFileURL(path).href)
    const warnings: string[] = []
    ctx.logger.exporter({
      export(message) {
        if (message.type === 'warn') warnings.push(format(...message.args))
      },
    })

    const reloaded = nextReload()
    writeFileSync(path, plugin('host', 'v2'))
    change(path)
    await reloaded
    await vi.waitFor(() => expect(warnings.some(warning => warning.includes('host.ts'))).to.equal(true))
    expect(ctx.bail('hmr-watch/host' as any)).to.equal('v1')
  })

  it('reloads a plugin when its file changes on disk', async () => {
    ctx = new Context()
    ctx.baseUrl = import.meta.url
    fiber = await ctx.plugin(Loader)
    await ctx.plugin(Fs)
    await ctx.plugin(Hmr, { watch: { enabled: true, root: ['__watch__'], debounce: 50 } })
    const path = await load('disk.ts', plugin('disk', 'v1'))

    // some platforms report changes late, so the file is rewritten until one is seen
    await vi.waitFor(() => {
      writeFileSync(path, plugin('disk', 'v2'))
      expect(ctx.bail('hmr-watch/disk' as any)).to.equal('v2')
    }, { timeout: 5000, interval: 200 })
  })
})
