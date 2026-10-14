import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Timer from '@cordisjs/plugin-timer'
import { dirname, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import Hmr from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))

describe('Hmr baseDir', () => {
  let fiber: Fiber<Context> | undefined

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
  })

  async function createContext(base?: string) {
    const ctx = new Context()
    ctx.baseUrl = import.meta.url
    await ctx.plugin(Loader)
    await ctx.plugin(Timer)
    fiber = await ctx.plugin(Hmr, base ? { base } : {})
    return ctx
  }

  // An absolute `base` is a legal configuration, but `new URL()` reads a Windows
  // drive letter as a URL scheme (`c:`) and `fileURLToPath` rejects that scheme.
  it.runIf(process.platform === 'win32')('accepts a drive-letter base', async () => {
    const base = testDir + sep
    const ctx = await createContext(base)

    expect(ctx.hmr.baseDir).to.equal(base)
  })

  // A relative base still resolves against the context, exactly as before.
  it('accepts a relative base', async () => {
    const ctx = await createContext()

    expect(ctx.hmr.baseDir).to.equal(testDir + sep)
  })
})
