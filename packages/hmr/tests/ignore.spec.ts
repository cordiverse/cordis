import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Timer from '@cordisjs/plugin-timer'
import Logger from '@cordisjs/plugin-logger-console'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))

// `ignored` matches `path.relative()`, which is backslash-separated on Windows.
// A top-level entry carries no separator, so it matched even there; a nested one
// did not, and chokidar descended into it.
const fixture = resolve(testDir, '__ignored__')
const nested = resolve(fixture, 'packages/core/node_modules/dep/index.js')
const plain = resolve(fixture, 'src/index.js')
const SETTLE_MS = 250

function seed() {
  rmSync(fixture, { recursive: true, force: true })
  for (const file of [nested, plain]) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'v0')
  }
}

describe('hmr ignored paths', () => {
  let ctx: Context
  let fiber: Fiber<Context>
  const changes: string[] = []

  beforeAll(async () => {
    seed()
    ctx = new Context()
    ctx.baseUrl = pathToFileURL(resolve(testDir, 'cordis-ignore.yml')).href
    await ctx.plugin(Logger)
    await ctx.plugin(Loader)
    await ctx.plugin(Timer)
    const hmr = await import('../src/index.ts')
    fiber = await ctx.plugin(hmr.default as any, {
      root: ['__ignored__'],
      debounce: 50,
    })
    ctx.on('hmr/change', (url: string) => changes.push(url))
    ctx.logger.exporter({ export: (m: any) => console.log('[log]', m.type, m.name, ...m.args) })
    await new Promise(r => setTimeout(r, SETTLE_MS))
    console.log('watchers active:', !!(ctx as any).hmr)
  }, 20000)

  afterAll(async () => {
    await fiber?.dispose()
    rmSync(fixture, { recursive: true, force: true })
    rmSync(resolve(testDir, 'cordis-ignore.yml'), { force: true })
  })

  it('still reports a change under a watched root', async () => {
    const before = changes.length
    writeFileSync(plain, 'v1')
    await new Promise(r => setTimeout(r, SETTLE_MS))
    expect(changes.length).to.be.greaterThan(before)
  }, 15000)

  it('does not report a change inside a nested node_modules', async () => {
    const before = changes.length
    writeFileSync(nested, 'v1')
    await new Promise(r => setTimeout(r, SETTLE_MS))
    expect(changes.slice(before)).to.deep.equal([])
  }, 15000)
})
