import { Context, Fiber } from 'cordis'
import { once } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'
import FsWatcher from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__fixtures__')

function waitFor(condFn: () => any, timeout = 8000, interval = 50): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const check = setInterval(() => {
      if (!condFn()) return
      clearInterval(check)
      clearTimeout(timer)
      resolve()
    }, interval)
    const timer = setTimeout(() => {
      clearInterval(check)
      reject(new Error('waitFor timed out'))
    }, timeout)
  })
}

describe('FsWatcher', () => {
  let fiber: Fiber<Context> | undefined

  beforeAll(() => {
    rmSync(fixture, { recursive: true, force: true })
    mkdirSync(fixture, { recursive: true })
  })

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
  })

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true })
  })

  async function createContext(config: Partial<FsWatcher.Config>) {
    const ctx = new Context()
    ctx.baseUrl = import.meta.url
    fiber = await ctx.plugin(FsWatcher, config)
    // chokidar never gets ready without anything to watch
    if (config.root?.length) await once(ctx.fsWatcher['_watcher'], 'ready')
    return { ctx }
  }

  // Only `baseDir` is asserted, so nothing is watched.
  describe('base', () => {
    // An absolute `base` is a legal configuration, but `new URL()` reads a Windows
    // drive letter as a URL scheme (`c:`) and `fileURLToPath` rejects that scheme.
    it.runIf(process.platform === 'win32')('accepts a drive-letter base', async () => {
      const base = testDir + sep
      const { ctx } = await createContext({ base, root: [] })

      expect(ctx.fsWatcher.baseDir).to.equal(base)
    })

    it('resolves a relative base against the context', async () => {
      const { ctx } = await createContext({ base: '..', root: [] })

      expect(ctx.fsWatcher.baseDir).to.equal(dirname(testDir) + sep)
    })

    it('defaults to the working directory without a context directory', async () => {
      const ctx = new Context()
      fiber = await ctx.plugin(FsWatcher, { root: [] })

      expect(ctx.fsWatcher.baseDir).to.equal(process.cwd())
    })

    const basePath = resolve(testDir, 'base with spaces # %')
    it.each([
      ['relative path', '../watcher base', resolve('../watcher base')],
      ['absolute path', basePath, basePath],
      ['file URL', pathToFileURL(basePath).href, basePath],
    ])('accepts a %s without a context directory', async (_, base, expected) => {
      const ctx = new Context()
      fiber = await ctx.plugin(FsWatcher, { base, root: [] })

      expect(ctx.fsWatcher.baseDir).to.equal(expected)
    })

    it('defaults to the context directory', async () => {
      const { ctx } = await createContext({ root: [] })

      expect(ctx.fsWatcher.baseDir).to.equal(testDir + sep)
    })
  })

  describe('ignored', () => {
    // `ignored` is matched against `path.relative()`, which is backslash-separated
    // on Windows. Only a top-level entry carries no separator, so a nested
    // `node_modules` was not ignored there and chokidar descended into it.
    it('does not watch a nested ignored directory', async () => {
      const root = resolve(fixture, 'ignored')
      for (const file of ['src/index.js', 'packages/core/node_modules/dep/index.js']) {
        mkdirSync(dirname(resolve(root, file)), { recursive: true })
        writeFileSync(resolve(root, file), '')
      }

      const { ctx } = await createContext({ root: ['__fixtures__/ignored'] })
      const watched = Object.entries(ctx.fsWatcher['_watcher'].getWatched())
        .flatMap(([dir, names]) => names.map(name => join(dir, name)))
      expect(watched).to.include(join('__fixtures__', 'ignored', 'src', 'index.js'))
      expect(watched.filter(path => path.includes('node_modules'))).to.deep.equal([])
    }, 10000)
  })

  describe('watch', () => {
    // matches the default `ignored` patterns, so only an explicit claim can
    // bring it into the watch set
    const dotPath = resolve(fixture, '.claimed.yml')

    beforeAll(() => {
      writeFileSync(dotPath, 'v0')
    })

    it('watches a path that `ignored` would skip', async () => {
      const { ctx } = await createContext({ root: ['__fixtures__'] })
      let calls = 0
      ctx.fsWatcher.watch(dotPath, () => { calls++ })
      await new Promise(r => setTimeout(r, 200))

      writeFileSync(dotPath, 'v1')
      await waitFor(() => calls > 0)
    }, 15000)

    it('runs every callback registered for the same path', async () => {
      const { ctx } = await createContext({ root: [] })
      const seen: string[] = []
      ctx.fsWatcher.watch(dotPath, () => { seen.push('a') })
      ctx.fsWatcher.watch(dotPath, () => { seen.push('b') })
      await new Promise(r => setTimeout(r, 200))

      writeFileSync(dotPath, 'v2')
      await waitFor(() => seen.length >= 2)
      expect([...seen].sort()).to.deep.equal(['a', 'b'])
    }, 15000)

    it('stops calling a callback once it is disposed', async () => {
      const { ctx } = await createContext({ root: [] })
      let calls = 0
      const dispose = ctx.fsWatcher.watch(dotPath, () => { calls++ })
      let others = 0
      ctx.fsWatcher.watch(dotPath, () => { others++ })
      await new Promise(r => setTimeout(r, 200))
      dispose()

      writeFileSync(dotPath, 'v3')
      await waitFor(() => others > 0)
      expect(calls).to.equal(0)
    }, 15000)

    it.runIf(process.platform === 'win32')('matches paths that differ in case on Windows', async () => {
      const { ctx } = await createContext({ root: [] })
      let calls = 0
      // drive letter and directories alike
      const dir = dirname(dotPath).replace(/[a-z]/gi, c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())
      ctx.fsWatcher.watch(resolve(dir, basename(dotPath)), () => { calls++ })
      await new Promise(r => setTimeout(r, 200))

      writeFileSync(dotPath, 'v4')
      await waitFor(() => calls > 0)
    }, 15000)
  })

  describe('change event', () => {
    const source = resolve(fixture, 'source.ts')

    beforeAll(() => {
      writeFileSync(source, 'export {}\n')
    })

    it('emits fs-watcher/change after the callbacks of the file', async () => {
      const { ctx } = await createContext({ root: ['__fixtures__'] })
      const order: string[] = []
      ctx.fsWatcher.watch(source, async () => {
        await new Promise(r => setTimeout(r, 100))
        order.push('callback')
      })
      ctx.on('fs-watcher/change', (filename) => {
        order.push(`change:${filename}`)
      })

      writeFileSync(source, 'export const a = 1\n')
      await waitFor(() => order.length >= 2)
      expect(order).to.deep.equal(['callback', `change:${source}`])
    }, 15000)
  })
})
