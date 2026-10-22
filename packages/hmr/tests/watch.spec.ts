import { Context, Fiber, Service } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
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

/** Stands in for `@cordisjs/plugin-fs-watcher`; changes are emitted by hand. */
class FakeFsWatcher extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fsWatcher')
  }
}

class TestLoader extends Loader {
  static exits = 0

  exit() {
    TestLoader.exits++
  }
}

describe('Hmr with a file system watcher', () => {
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
    TestLoader.exits = 0
  })

  async function setup(watcher = true) {
    ctx = new Context()
    fiber = await ctx.plugin(TestLoader, { baseUrl: import.meta.url })
    if (watcher) await ctx.plugin(FakeFsWatcher)
    await ctx.plugin(Hmr, { debounce: 50 })
  }

  async function load(name: string, content: string) {
    const path = resolve(fixtureDir, name)
    writeFileSync(path, content)
    const id = await ctx.loader.create({ name: `./__watch__/${name}` })
    await ctx.loader.store[id]!.fiber!.await()
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

  it('reconciles the changes of one debounce window as a batch', async () => {
    await setup()
    const a = await load('batch-a.ts', plugin('a', 'v1'))
    const b = await load('batch-b.ts', plugin('b', 'v1'))

    let reloads = 0
    ctx.on('hmr/reload', () => { reloads++ })
    const reloaded = nextReload()
    writeFileSync(a, plugin('a', 'v2'))
    writeFileSync(b, plugin('b', 'v2'))
    ctx.emit('fs-watcher/change', a)
    ctx.emit('fs-watcher/change', b)
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

    ctx.emit('fs-watcher/change', path)
    await new Promise(r => setTimeout(r, 200))

    expect(TestLoader.exits).to.equal(1)
    expect(ctx.bail('hmr-watch/host' as any)).to.equal('v1')
  })

  it('ignores file system changes without a watcher', async () => {
    await setup(false)
    const path = await load('unwatched.ts', plugin('unwatched', 'v1'))

    writeFileSync(path, plugin('unwatched', 'v2'))
    ctx.emit('fs-watcher/change', path)
    await new Promise(r => setTimeout(r, 200))

    expect(ctx.bail('hmr-watch/unwatched' as any)).to.equal('v1')
  })
})
