import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Timer from '@cordisjs/plugin-timer'
import { once } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import Hmr from '../src'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__ignored__')

describe('hmr ignored paths', () => {
  let fiber: Fiber<Context> | undefined

  afterAll(async () => {
    await fiber?.dispose()
    rmSync(fixture, { recursive: true, force: true })
  })

  // `ignored` is matched against `path.relative()`, which is backslash-separated
  // on Windows. Only a top-level entry carries no separator, so a nested
  // `node_modules` was not ignored there and chokidar descended into it.
  it('does not watch a nested ignored directory', async () => {
    rmSync(fixture, { recursive: true, force: true })
    for (const file of ['src/index.js', 'packages/core/node_modules/dep/index.js']) {
      mkdirSync(dirname(resolve(fixture, file)), { recursive: true })
      writeFileSync(resolve(fixture, file), '')
    }

    const ctx = new Context()
    ctx.baseUrl = import.meta.url
    await ctx.plugin(Loader)
    await ctx.plugin(Timer)
    fiber = await ctx.plugin(Hmr, { root: ['__ignored__'] })
    const watcher = ctx.hmr['watcher']
    await once(watcher, 'ready')

    const watched = Object.entries(watcher.getWatched())
      .flatMap(([dir, names]) => names.map(name => join(dir, name)))
    expect(watched).to.include(join('__ignored__', 'src', 'index.js'))
    expect(watched.filter(path => path.includes('node_modules'))).to.deep.equal([])
  }, 10000)
})
