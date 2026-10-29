// Probe: pnpm isolated layout — retarget the link, then reconcile.
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Hmr from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__probe_pnpm__')

describe('pnpm isolated layout', () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
  })
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('reloads a package whose symlink was retargeted', async () => {
    const dirs: Record<string, string> = {}
    for (const tag of ['1', '2']) {
      const dir = join(base, `v${tag}`, 'node_modules', 'pkg')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg', main: 'index.js' }))
      writeFileSync(join(dir, 'index.js'), `module.exports = 'v${tag}'\n`)
      dirs[tag] = dir
    }
    const app = join(base, 'app')
    mkdirSync(join(app, 'node_modules'), { recursive: true })
    const link = join(app, 'node_modules', 'pkg')
    const kind = process.platform === 'win32' ? 'junction' : undefined
    symlinkSync(dirs['1'], link, kind)
    writeFileSync(join(app, 'entry.ts'), `
import value from 'pkg'

export const name = 'pnpmPkg'

export async function apply(ctx: any) {
  ctx.on('probe/pnpm' as any, () => value)
}
`)

    const ctx = new Context()
    const fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    await ctx.plugin(Hmr)
    const id = await ctx.loader.create({ name: './__probe_pnpm__/app/entry.ts' })
    await ctx.loader.store[id]!.innerFiber!.await().catch(() => {})
    expect(ctx.bail('probe/pnpm' as any)).to.equal('v1')

    rmSync(link, { recursive: true, force: true })
    symlinkSync(dirs['2'], link, kind)

    const result = await ctx.hmr.reconcile({ roots: [link] })
    expect(result.settledFibers).to.have.length(1)
    expect(ctx.bail('probe/pnpm' as any)).to.equal('v2')
    await fiber.dispose()
  }, 30000)

  it('reloads a scoped package whose symlink was retargeted', async () => {
    const dirs: Record<string, string> = {}
    for (const tag of ['1', '2']) {
      const dir = join(base, `scoped-v${tag}`, 'node_modules', '@scope', 'pkg')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@scope/pkg', main: 'index.js' }))
      writeFileSync(join(dir, 'index.js'), `module.exports = 'scoped-v${tag}'\n`)
      dirs[tag] = dir
    }
    const app = join(base, 'scoped-app')
    mkdirSync(join(app, 'node_modules', '@scope'), { recursive: true })
    const link = join(app, 'node_modules', '@scope', 'pkg')
    const kind = process.platform === 'win32' ? 'junction' : undefined
    symlinkSync(dirs['1'], link, kind)
    writeFileSync(join(app, 'entry.ts'), `
import value from '@scope/pkg'

export const name = 'pnpmScopedPkg'

export async function apply(ctx: any) {
  ctx.on('probe/pnpm-scoped' as any, () => value)
}
`)

    const ctx = new Context()
    const fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    await ctx.plugin(Hmr)
    const id = await ctx.loader.create({ name: './__probe_pnpm__/scoped-app/entry.ts' })
    await ctx.loader.store[id]!.innerFiber!.await().catch(() => {})
    expect(ctx.bail('probe/pnpm-scoped' as any)).to.equal('scoped-v1')

    rmSync(link, { recursive: true, force: true })
    symlinkSync(dirs['2'], link, kind)

    const result = await ctx.hmr.reconcile({ roots: [link] })
    expect(result.settledFibers).to.have.length(1)
    expect(ctx.bail('probe/pnpm-scoped' as any)).to.equal('scoped-v2')
    await fiber.dispose()
  }, 30000)
})
