import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import Hmr from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(testDir, '__unit__')

function fixture(name: string, content: string) {
  const path = resolve(fixtureDir, name)
  writeFileSync(path, content)
  return path
}

describe('Hmr per-unit atomicity', () => {
  let ctx: Context
  let fiber: any

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
  })

  async function setup() {
    ctx = new Context()
    fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    await ctx.plugin(Hmr)
    return ctx
  }

  async function load(name: string, content: string) {
    const path = fixture(name, content)
    const id = await ctx.loader.create({ name: `./__unit__/${name}` })
    await ctx.loader.store[id]!.innerFiber!.await().catch(() => {})
    return path
  }

  // One broken dependency must not keep an unrelated plugin from reloading.
  it('reloads an unrelated plugin when another package is broken', async () => {
    await setup()
    fixture('a-dep.ts', `export const value = 'a1'\n`)
    fixture('b-dep.ts', `export const value = 'b1'\n`)
    await load('a.ts', `
import { value } from './a-dep.ts'

export const name = 'a'

export async function apply(ctx: any) {
  ctx.on('unit/a' as any, () => value)
}
`)
    await load('b.ts', `
import { value } from './b-dep.ts'

export const name = 'b'

export async function apply(ctx: any) {
  ctx.on('unit/b' as any, () => value)
}
`)
    expect(ctx.bail('unit/a' as any)).to.equal('a1')
    expect(ctx.bail('unit/b' as any)).to.equal('b1')

    // one dependency breaks on import, the other changes value
    fixture('a-dep.ts', `throw new Error('broken package')\n`)
    fixture('b-dep.ts', `export const value = 'b2'\n`)
    const result = await ctx.hmr.reconcile({
      files: [resolve(fixtureDir, 'a-dep.ts'), resolve(fixtureDir, 'b-dep.ts')],
    })

    // the broken unit aborts on its own; the unrelated one commits, and the
    // report says which is which
    expect(result.aborted).to.have.length(1)
    expect(result.aborted![0].changed.map(url => url.split('/').pop()).sort()).to.deep.equal(['a-dep.ts'])
    expect(result.units).to.have.length(2)
    const applied = result.units.filter(unit => !unit.aborted)
    const aborted = result.units.filter(unit => unit.aborted)
    expect(applied).to.have.length(1)
    expect(applied[0].replaced).to.have.length(1)
    expect(aborted).to.have.length(1)
    expect(aborted[0].changed.map(url => url.split('/').pop())).to.deep.equal(['a-dep.ts'])
    expect(ctx.bail('unit/a' as any)).to.equal('a1')
    expect(ctx.bail('unit/b' as any)).to.equal('b2')
  }, 30000)

  // Fibers that share an evicted module are one unit: a shared dependency that
  // breaks takes both down, because its new version serves both of them.
  it('aborts both fibers when a shared dependency breaks', async () => {
    await setup()
    fixture('shared.ts', `export const value = 's1'\n`)
    await load('x.ts', `
import { value } from './shared.ts'

export const name = 'x'

export async function apply(ctx: any) {
  ctx.on('unit/x' as any, () => value)
}
`)
    await load('y.ts', `
import { value } from './shared.ts'

export const name = 'y'

export async function apply(ctx: any) {
  ctx.on('unit/y' as any, () => value)
}
`)
    expect(ctx.bail('unit/x' as any)).to.equal('s1')
    expect(ctx.bail('unit/y' as any)).to.equal('s1')

    fixture('shared.ts', `throw new Error('shared package broken')\n`)
    const result = await ctx.hmr.reconcile({ files: [resolve(fixtureDir, 'shared.ts')] })

    expect(result.aborted).to.be.ok
    expect(result.replaced).to.have.length(0)
    expect(ctx.bail('unit/x' as any)).to.equal('s1')
    expect(ctx.bail('unit/y' as any)).to.equal('s1')
  }, 30000)

  // A shared module that did not change is not evicted, so it never joins two
  // units together: the broken one aborts, the other still commits.
  it('keeps an unchanged shared module from joining two units', async () => {
    await setup()
    fixture('keep.ts', `export const value = 'k1'\n`)
    fixture('u-dep.ts', `export const value = 'u1'\n`)
    fixture('v-dep.ts', `export const value = 'v1'\n`)
    await load('u.ts', `
import { value as keep } from './keep.ts'
import { value } from './u-dep.ts'

export const name = 'u'

export async function apply(ctx: any) {
  ctx.on('unit/u' as any, () => keep + value)
}
`)
    await load('v.ts', `
import { value as keep } from './keep.ts'
import { value } from './v-dep.ts'

export const name = 'v'

export async function apply(ctx: any) {
  ctx.on('unit/v' as any, () => keep + value)
}
`)
    expect(ctx.bail('unit/u' as any)).to.equal('k1u1')
    expect(ctx.bail('unit/v' as any)).to.equal('k1v1')

    fixture('u-dep.ts', `throw new Error('u package broken')\n`)
    fixture('v-dep.ts', `export const value = 'v2'\n`)
    const result = await ctx.hmr.reconcile({
      files: [resolve(fixtureDir, 'u-dep.ts'), resolve(fixtureDir, 'v-dep.ts')],
    })

    expect(result.aborted).to.be.ok
    expect(result.replaced).to.have.length(1)
    expect(ctx.bail('unit/u' as any)).to.equal('k1u1')
    expect(ctx.bail('unit/v' as any)).to.equal('k1v2')
  }, 30000)

  // More than one broken unit must not take the batch down with it, and the
  // report names a failure even though `aborted` holds one error.
  it('aborts the batch when more than one unit breaks', async () => {
    await setup()
    fixture('q1-dep.ts', `export const value = 'q1'\n`)
    fixture('q2-dep.ts', `export const value = 'q2'\n`)
    await load('q1.ts', `
import { value } from './q1-dep.ts'

export const name = 'q1'

export async function apply(ctx: any) {
  ctx.on('unit/q1' as any, () => value)
}
`)
    await load('q2.ts', `
import { value } from './q2-dep.ts'

export const name = 'q2'

export async function apply(ctx: any) {
  ctx.on('unit/q2' as any, () => value)
}
`)
    expect(ctx.bail('unit/q1' as any)).to.equal('q1')
    expect(ctx.bail('unit/q2' as any)).to.equal('q2')

    fixture('q1-dep.ts', `throw new Error('first broken package')\n`)
    fixture('q2-dep.ts', `throw new Error('second broken package')\n`)
    const result = await ctx.hmr.reconcile({
      files: [resolve(fixtureDir, 'q1-dep.ts'), resolve(fixtureDir, 'q2-dep.ts')],
    })

    // both failures are reported, not only the first one
    expect(result.aborted).to.have.length(2)
    const files = result.aborted!.map(abort => abort.changed.map(url => url.split('/').pop())).flat().sort()
    expect(files).to.deep.equal(['q1-dep.ts', 'q2-dep.ts'])
    expect(result.units.every(unit => unit.aborted)).to.equal(true)
    expect(result.replaced).to.have.length(0)
    // both units went back to the modules they had
    expect(ctx.bail('unit/q1' as any)).to.equal('q1')
    expect(ctx.bail('unit/q2' as any)).to.equal('q2')
  }, 30000)

  // An aborted unit puts the caches back to the state before its attempt: the
  // modules it evicted return, and the ones its new version introduced — which
  // no scope covers — do not stay behind.
  it('puts the caches back when a unit aborts', async () => {
    await setup()
    fixture('rollback-dep.ts', `export const value = 'r1'\n`)
    await load('rollback.ts', `
import { value } from './rollback-dep.ts'

export const name = 'rollback'

export async function apply(ctx: any) {
  ctx.on('unit/rollback' as any, () => value)
}
`)
    // the new version pulls in a module the old one never had, then breaks
    fixture('new-only.ts', `export const x = 1\n`)
    fixture('rollback-dep.ts', `import { x } from './new-only.ts'\nthrow new Error('broken')\n`)
    const result = await ctx.hmr.reconcile({ files: [resolve(fixtureDir, 'rollback-dep.ts')] })
    expect(result.aborted).to.have.length(1)

    const cache = ctx.loader.internal!.loadCache
    const held = (name: string) => Map.prototype.has.call(cache, pathToFileURL(resolve(fixtureDir, name)).href)
    expect(held('new-only.ts')).to.equal(false)
    expect(held('rollback-dep.ts')).to.equal(true)
  }, 30000)

  // A fiber that fails inside `apply` is reported per fiber, not swallowed.
  it('reports a fiber that fails to restart', async () => {
    await setup()
    await load('boom.ts', `
export const name = 'boom'

export async function apply(ctx: any) {
  throw new Error('boom')
}
`)
    const result = await ctx.hmr.reconcile({ files: [resolve(fixtureDir, 'boom.ts')] })
    expect(result.failed).to.have.length(1)
  }, 30000)

  // Narrowing the eviction to what a change reaches must not break the
  // propagation: a module between the plugin and the changed file is
  // re-evaluated, so the plugin observes the new value.
  it('still propagates through an intermediate module', async () => {
    await setup()
    fixture('mid-dep.ts', `export const value = 'm1'\n`)
    await load('mid.ts', `
import { value } from './mid-dep.ts'

export const name = 'mid'

export async function apply(ctx: any) {
  ctx.on('unit/mid' as any, () => value)
}
`)

    fixture('mid-dep.ts', `export const value = 'm2'\n`)
    const result = await ctx.hmr.reconcile({ files: [resolve(fixtureDir, 'mid-dep.ts')] })
    expect(result.replaced).to.have.length(1)
    expect(ctx.bail('unit/mid' as any)).to.equal('m2')
  }, 30000)

  // The narrowed eviction leaves a module that nothing reached untouched: its
  // evaluation count does not move, which is what keeps unrelated units apart.
  it('leaves an unreached module unevicted', async () => {
    const global = globalThis as any
    global.__unitCount = 0
    fixture('counter.ts', `;(globalThis as any).__unitCount++\nexport const value = 'c1'\n`)
    fixture('reach.ts', `export const value = 'r1'\n`)
    await setup()
    await load('counted.ts', `
import { value as count } from './counter.ts'
import { value as reach } from './reach.ts'

export const name = 'counted'

export async function apply(ctx: any) {
  ctx.on('unit/counted' as any, () => count + reach)
}
`)
    const before = global.__unitCount
    expect(before).to.be.greaterThan(0)

    // `reach` changes and reaches the plugin; `counter` is on no path to it
    // and stays as it is
    fixture('reach.ts', `export const value = 'r2'\n`)
    const result = await ctx.hmr.reconcile({ files: [resolve(fixtureDir, 'reach.ts')] })
    expect(result.replaced).to.have.length(1)
    expect(ctx.bail('unit/counted' as any)).to.equal('c1r2')
    expect(global.__unitCount).to.equal(before)
  }, 30000)
})
