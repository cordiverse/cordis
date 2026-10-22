import { Context, Fiber, Service } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import type { WatchCallback, WatchOptions } from '@cordisjs/plugin-fs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
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

class TestLoader extends Loader {
  static exits = 0

  exit() {
    TestLoader.exits++
  }
}

describe('Hmr with fs', () => {
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
    FakeFs.watches = []
    TestLoader.exits = 0
  })

  async function setup(config: Partial<Hmr.Config> = {}, fs = true) {
    ctx = new Context()
    ctx.baseUrl = import.meta.url
    fiber = await ctx.plugin(TestLoader)
    if (fs) await ctx.plugin(FakeFs)
    await ctx.plugin(Hmr, { debounce: 50, ...config })
  }

  async function load(name: string, content: string) {
    const path = resolve(fixtureDir, name)
    writeFileSync(path, content)
    const id = await ctx.loader.create({ name: `./__watch__/${name}` })
    await ctx.loader.store[id]!.innerFiber!.await()
    return path
  }

  function nextReload() {
    return new Promise<Hmr.Result>((resolve) => {
      const dispose = ctx.on('hmr/reload', (result) => {
        dispose()
        resolve(result)
      })
    })
  }

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

    let reloads = 0
    ctx.on('hmr/reload', () => { reloads++ })
    const reloaded = nextReload()
    writeFileSync(a, plugin('a', 'v2'))
    writeFileSync(b, plugin('b', 'v2'))
    change(a)
    change(b)
    const result = await reloaded

    expect(result.replaced).to.have.length(2)
    expect(ctx.bail('hmr-watch/a' as any)).to.equal('v2')
    expect(ctx.bail('hmr-watch/b' as any)).to.equal('v2')
    await new Promise(r => setTimeout(r, 100))
    expect(reloads).to.equal(1)
  })

  it('calls loader.exit() when a restart is required', async () => {
    await setup()
    const path = await load('host.ts', plugin('host', 'v1'))
    ctx.hmr.hosts.add(pathToFileURL(path).href)

    change(path)
    await new Promise(r => setTimeout(r, 200))

    expect(TestLoader.exits).to.equal(1)
    expect(ctx.bail('hmr-watch/host' as any)).to.equal('v1')
  })

  it('does not watch without fs', async () => {
    await setup({}, false)
    const path = await load('unwatched.ts', plugin('unwatched', 'v1'))
    writeFileSync(path, plugin('unwatched', 'v2'))
    await new Promise(r => setTimeout(r, 200))

    expect(FakeFs.watches).to.deep.equal([])
    expect(ctx.bail('hmr-watch/unwatched' as any)).to.equal('v1')
  })
})
