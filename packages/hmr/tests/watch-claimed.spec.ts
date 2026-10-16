import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Logger from '@cordisjs/plugin-logger-console'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, describe, it, beforeAll, afterEach, afterAll } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))
const SETTLE_MS = 500
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function backupFile(filename: string) {
  const path = resolve(testDir, filename)
  const original = readFileSync(path, 'utf-8')
  return {
    path,
    modify(replaceFn: (content: string) => string) { writeFileSync(path, replaceFn(original)) },
    restore() { writeFileSync(path, original) },
  }
}

function waitFor(condFn: () => any, timeout = 8000, interval = 100): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const check = setInterval(() => {
      if (condFn()) { clearInterval(check); resolve() }
    }, interval)
    setTimeout(() => { clearInterval(check); reject(new Error('waitFor timed out')) }, timeout)
  })
}

async function createContext(configFile: string): Promise<{ ctx: Context; fiber: Fiber<Context> }> {
  const ctx = new Context()
  await ctx.plugin(Logger)
  const fiber = await ctx.plugin(Loader)
  await ctx.loader.create({
    name: '@cordisjs/plugin-include',
    config: { path: pathToFileURL(resolve(testDir, configFile)).href },
  })
  await waitFor(() => ctx.hmr, 5000)
  await sleep(SETTLE_MS)
  return { ctx, fiber }
}

describe('HMR: a file claimed by a watch callback', () => {
  let ctx: Context
  let fiber: Fiber<Context>
  const plugin = backupFile('plugin.ts')
  const disposables: (() => any)[] = []

  beforeAll(async () => {
    plugin.restore()
    const result = await createContext('cordis.yml')
    ctx = result.ctx
    fiber = result.fiber
  }, 15000)

  afterEach(async () => {
    disposables.splice(0).forEach(dispose => dispose())
    plugin.restore()
    await sleep(SETTLE_MS)
  })

  afterAll(async () => {
    fiber?.dispose()
    await sleep(200)
  })

  it('is handled by its callback alone, not reloaded as well', async () => {
    expect(ctx.bail('hmr-test/get-value')).to.equal('initial')

    let calls = 0
    disposables.push(ctx.hmr.watch(plugin.path, () => { calls++ }))
    await sleep(SETTLE_MS)

    plugin.modify(c => c.replace("value = 'initial'", "value = 'modified'"))
    await waitFor(() => calls > 0)
    await sleep(SETTLE_MS)

    // The callback owns this file. Falling through would reload the module on
    // top of it, so the plugin would report the new value as well.
    expect(calls).to.be.greaterThan(0)
    expect(ctx.bail('hmr-test/get-value')).to.equal('initial')
  }, 20000)
})
