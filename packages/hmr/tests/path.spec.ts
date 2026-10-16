import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Timer from '@cordisjs/plugin-timer'
import { once } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import Hmr from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__ignored__')

describe('Hmr path', () => {
  let fiber: Fiber<Context> | undefined

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
  })

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true })
  })

  async function createContext(config: Partial<Hmr.Config>) {
    const ctx = new Context()
    ctx.baseUrl = import.meta.url
    await ctx.plugin(Loader)
    await ctx.plugin(Timer)
    fiber = await ctx.plugin(Hmr, config)
    return ctx
  }

  // Only `baseDir` is asserted, so nothing is watched.
  describe('base', () => {
    // An absolute `base` is a legal configuration, but `new URL()` reads a Windows
    // drive letter as a URL scheme (`c:`) and `fileURLToPath` rejects that scheme.
    it.runIf(process.platform === 'win32')('accepts a drive-letter base', async () => {
      const base = testDir + sep
      const ctx = await createContext({ base, root: [] })

      expect(ctx.hmr.baseDir).to.equal(base)
    })

    it('resolves a relative base against the context', async () => {
      const ctx = await createContext({ base: '..', root: [] })

      expect(ctx.hmr.baseDir).to.equal(dirname(testDir) + sep)
    })

    it('defaults to the context directory', async () => {
      const ctx = await createContext({ root: [] })

      expect(ctx.hmr.baseDir).to.equal(testDir + sep)
    })
  })

  describe('ignored', () => {
    // `ignored` is matched against `path.relative()`, which is backslash-separated
    // on Windows. Only a top-level entry carries no separator, so a nested
    // `node_modules` was not ignored there and chokidar descended into it.
    it('does not watch a nested ignored directory', async () => {
      rmSync(fixture, { recursive: true, force: true })
      for (const file of ['src/index.js', 'packages/core/node_modules/dep/index.js']) {
        mkdirSync(dirname(resolve(fixture, file)), { recursive: true })
        writeFileSync(resolve(fixture, file), '')
      }

      const ctx = await createContext({ root: ['__ignored__'] })
      const watcher = ctx.hmr['watcher']
      await once(watcher, 'ready')

      const watched = Object.entries(watcher.getWatched())
        .flatMap(([dir, names]) => names.map(name => join(dir, name)))
      expect(watched).to.include(join('__ignored__', 'src', 'index.js'))
      expect(watched.filter(path => path.includes('node_modules'))).to.deep.equal([])
    }, 10000)

    // `cache` and `data` carry no `**/` prefix, so they only match a top-level
    // entry, and a nested one is watched. Its own root and `base` keep the tree
    // clear of the other cases, and it is removed only once the watcher is closed.
    it('does not watch a nested cache or data directory', async () => {
      const nested = resolve(fixture, '__nested__')
      rmSync(nested, { recursive: true, force: true })
      try {
        for (const file of [
          'src/index.js',
          'cache/root.js',
          'data/root.js',
          'packages/core/cache/nested.js',
          'packages/core/data/nested.js',
        ]) {
          mkdirSync(dirname(resolve(nested, file)), { recursive: true })
          writeFileSync(resolve(nested, file), '')
        }

        const ctx = await createContext({ base: nested + sep, root: ['.'] })
        const watcher = ctx.hmr['watcher']
        await once(watcher, 'ready')

        const watched = Object.entries(watcher.getWatched())
          .flatMap(([dir, names]) => names.map(name => join(dir, name)))
        expect(watched).to.include(join('src', 'index.js'))
        // A nested entry only matches `**/cache` or `**/data`, not the bare patterns.
        expect(watched.filter(path => /packages[\\/]core[\\/](cache|data)/.test(path)))
          .to.deep.equal([])
      } finally {
        await fiber?.dispose()
        fiber = undefined
        rmSync(nested, { recursive: true, force: true })
      }
    }, 10000)
  })
})
