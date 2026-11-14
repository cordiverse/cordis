import { Context } from 'cordis'
import Loader from '@cordisjs/loader'
import Fs from '@cordisjs/fs'
import NodeFs from '@cordisjs/fs-node'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, type TestContext, vi } from 'vitest'
import Hmr from '../src/index.ts'

function plugin(value: string) {
  return `
import { Context } from 'cordis'

export function apply(ctx: Context) {
  ctx.on('symlink/value' as any, () => '${value}')
}
`
}

describe('Hmr watch and symlinks', () => {
  let ctx: Context | undefined
  let dir: string | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  function link(test: TestContext, target: string, path: string) {
    try {
      symlinkSync(target, path, 'dir')
      return true
    } catch (error) {
      if (process.platform === 'win32') {
        test.skip('symlinks are unavailable')
        return false
      }
      throw error
    }
  }

  async function setup(base: string, baseUrl: string, name: string, root = ['.']) {
    ctx = new Context()
    ctx.baseUrl = baseUrl
    await ctx.use(Loader)
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    await ctx.use(Hmr, { base, watch: { enabled: true, files: root, debounce: 30 } })
    const id = await ctx.loader.create({ name })
    await ctx.loader.store[id]!.innerFiber!.await()
    expect(ctx.bail('symlink/value' as any)).to.equal('v1')
  }

  it('reloads a changed file below a symlinked base', async (test) => {
    dir = mkdtempSync(join(tmpdir(), 'cordis-hmr-symlink-base-'))
    const real = join(dir, 'real')
    mkdirSync(real)
    if (!link(test, real, join(dir, 'link'))) return
    writeFileSync(join(real, 'plugin.ts'), plugin('v1'))

    await setup(join(dir, 'link'), pathToFileURL(join(dir, 'link') + '/').href, './plugin.ts')
    await vi.waitFor(() => {
      writeFileSync(join(real, 'plugin.ts'), plugin('v2'))
      expect(ctx!.bail('symlink/value' as any)).to.equal('v2')
    }, { timeout: 5000, interval: 200 })
  }, 15000)

  it('reloads a changed file below a symlinked directory', async (test) => {
    dir = mkdtempSync(join(tmpdir(), 'cordis-hmr-symlink-dir-'))
    const target = join(dir, 'target')
    mkdirSync(target)
    if (!link(test, target, join(dir, 'sub'))) return
    writeFileSync(join(target, 'plugin.ts'), plugin('v1'))

    await setup(dir, pathToFileURL(dir + '/').href, './sub/plugin.ts', ['sub'])
    await vi.waitFor(() => {
      writeFileSync(join(target, 'plugin.ts'), plugin('v2'))
      expect(ctx!.bail('symlink/value' as any)).to.equal('v2')
    }, { timeout: 5000, interval: 200 })
  }, 15000)
})
