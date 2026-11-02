import { Context } from 'cordis'
import { ModuleLoader } from '@cordisjs/loader-utils'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, type TestContext } from 'vitest'
import Hmr from '../src/index.ts'

describe('Hmr host modules', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
  })

  async function findEntry(test: TestContext, cacheRealPath: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'cordis-hmr-entry-'))
    try {
      const real = join(dir, 'entry.mjs')
      writeFileSync(real, '')
      const realUrl = pathToFileURL(realpathSync(real)).href
      const link = join(dir, 'link.mjs')
      try {
        symlinkSync('entry.mjs', link)
      } catch (error) {
        // Windows without symlink privilege: the case cannot be constructed.
        if (process.platform === 'win32') return test.skip('symlinks are unavailable')
        throw error
      }
      const linkUrl = pathToFileURL(resolve(link)).href
      const cacheUrl = cacheRealPath ? realUrl : linkUrl
      const loader = ModuleLoader.fromInternal()!
      Map.prototype.set.call(loader.loadCache, cacheUrl, {
        javascript: { url: cacheUrl, linked: Promise.resolve([]) },
      })
      const argv = process.argv[1]
      process.argv[1] = link
      try {
        ctx = new Context()
        await ctx.plugin(Hmr, { watch: { enabled: false } })
        expect(ctx.hmr.hostModules.has(cacheUrl)).to.equal(true)
      } finally {
        process.argv[1] = argv
        Map.prototype.delete.call(loader.loadCache, cacheUrl)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('finds the entry when Node resolves it to the real path', async (test) => {
    await findEntry(test, true)
  })

  it('finds the entry when --preserve-symlinks-main keeps the link', async (test) => {
    await findEntry(test, false)
  })
})
