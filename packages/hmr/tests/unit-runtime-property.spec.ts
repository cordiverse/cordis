/**
 * Runtime property test for issue #243 item 4: `reconcile` splits a batch into
 * independent units, and a unit's rollback must not touch another unit.
 *
 * `unit-property.spec.ts` checks `groupUnits` on generated graphs, but it never
 * runs a transaction. This test generates real modules on disk, loads real
 * plugins through the loader, rewrites a random subset of their dependencies,
 * and calls `reconcile` on the changed files.
 *
 * The generated dependency graph is a DAG of leaf modules; a plugin imports one
 * or more roots and registers an event whose value is the concatenation of the
 * roots. A changed module either exports a new version or imports a fresh
 * marker and throws. From that model the test computes, independently of the
 * implementation:
 *
 * 1. the units: the connected components of plugins linked by a changed module
 *    they share;
 * 2. which units commit: a component commits iff no changed module reachable
 *    from any of its plugins throws;
 * 3. the value each plugin must expose: the new one when its component commits,
 *    the old one when it aborts (including a plugin that shares a changed
 *    module with a failing plugin but does not reach the broken module itself);
 * 4. the cache state: a failed unit restores the jobs it evicted and removes
 *    the modules its failed attempt imported, while a committed unit keeps its
 *    new jobs and the module its new version imported.
 *
 * That last part is what makes a rollback observable: a changed module's new
 * version imports a module absent from the old graph, so it only exists in the
 * cache if the failed attempt's additions were discarded. An implementation
 * that restores the old jobs but leaves the additions behind passes the value
 * check and fails this one.
 *
 * The generator only produces input the real pipeline can produce: imports are
 * static for the whole round, every changed module is loaded, and a plugin is
 * exported by exactly one module. Each round uses a fresh directory, so the
 * process-wide module cache cannot leak a module from one round into another.
 */
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import type { ModuleLoader } from '@cordisjs/plugin-loader'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Hmr from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = resolve(testDir, '__runtime-property__')

const SEED = 0x51f0c3d
const ROUNDS = 16

function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

interface Dep {
  /** lower-index modules this module imports */
  imports: number[]
}

interface PluginNode {
  /** dependency roots this plugin imports */
  roots: number[]
  event: string
  url: string
}

interface Round {
  dir: string
  deps: Dep[]
  plugins: PluginNode[]
  changed: Set<number>
  broken: Set<number>
  /** 1 for unchanged, 2 for a changed module */
  version: number[]
}

function shuffle<T>(items: T[], random: () => number) {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[result[index], result[swap]] = [result[swap]!, result[index]!]
  }
  return result
}

function generate(seed: number): Omit<Round, 'dir'> {
  const random = mulberry32(seed)
  const int = (bound: number) => Math.floor(random() * bound)
  const depCount = 5 + int(4)
  const pluginCount = 2 + int(3)

  const deps: Dep[] = []
  for (let index = 0; index < depCount; index++) {
    const imports = []
    for (let lower = 0; lower < index; lower++) {
      if (random() < 0.28) imports.push(lower)
    }
    deps.push({ imports })
  }

  // Each dependency belongs to one or two plugins. Sharing a changed
  // dependency is what forms a multi-plugin unit; an unchanged shared
  // dependency must not join two units.
  const roots = Array.from({ length: pluginCount }, () => [] as number[])
  for (let dep = 0; dep < depCount; dep++) {
    const owners = random() < 0.45 ? 2 : 1
    for (const plugin of shuffle([...Array(pluginCount).keys()], random).slice(0, owners)) {
      roots[plugin]!.push(dep)
    }
  }
  for (let plugin = 0; plugin < pluginCount; plugin++) {
    if (!roots[plugin]!.length) roots[plugin]!.push(int(depCount))
  }

  const changed = new Set<number>()
  for (let dep = 0; dep < depCount; dep++) {
    if (random() < 0.4) changed.add(dep)
  }
  if (!changed.size) changed.add(int(depCount))
  if (changed.size === depCount && depCount > 1) {
    changed.delete(shuffle([...changed], random)[0]!)
  }

  // Half the rounds keep every unit alive; the other half breaks one or two
  // changed modules and leaves the rest intact, so a batch can both commit and
  // abort. A failure round always has a broken module reachable from a plugin,
  // because every dependency is a root or a dependency of one.
  const broken = new Set<number>()
  if (seed % 2) {
    const candidates = shuffle([...changed], random)
    const count = changed.size > 1 && random() < 0.35 ? 2 : 1
    for (const dep of candidates.slice(0, Math.min(count, candidates.length))) broken.add(dep)
  }

  const version = Array.from({ length: depCount }, (_, dep) => changed.has(dep) ? 2 : 1)
  const slug = seed.toString(16)
  const plugins = roots.map((pluginRoots, index) => ({
    roots: [...new Set(pluginRoots)],
    event: `runtime/${slug}/${index}`,
    url: pathToFileURL(resolve(fixtureRoot, `r${slug}`, `p${index}.ts`)).href,
  }))

  return { deps, plugins, changed, broken, version }
}

/** The value a module exports after the change, or `undefined` if it throws. */
function depValue(deps: Dep[], version: number[], broken: Set<number>, dep: number): string | undefined {
  if (broken.has(dep)) return undefined
  const children = deps[dep]!.imports.map(child => depValue(deps, version, broken, child))
  if (children.some(child => child === undefined)) return undefined
  const own = `d${dep}v${version[dep]}`
  return children.length ? `${own}(${children.join('|')})` : own
}

function pluginValue(round: Omit<Round, 'dir'>, plugin: PluginNode, version: number[], broken: Set<number>) {
  const values = plugin.roots.map(dep => depValue(round.deps, version, broken, dep))
  if (values.some(value => value === undefined)) return undefined
  return values.join('+')
}

function closureOf(deps: Dep[], roots: number[]) {
  const closure = new Set<number>()
  const queue = [...roots]
  while (queue.length) {
    const dep = queue.pop()!
    if (closure.has(dep)) continue
    closure.add(dep)
    queue.push(...deps[dep]!.imports)
  }
  return closure
}

/** Connected components of the plugins that share a changed dependency. */
function componentsOf(round: Omit<Round, 'dir'>) {
  const closures = round.plugins.map(plugin => closureOf(round.deps, plugin.roots))
  const changedOf = closures.map(closure => new Set([...closure].filter(dep => round.changed.has(dep))))
  const parent = round.plugins.map((_, index) => index)
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!
      index = parent[index]!
    }
    return index
  }
  for (let left = 0; left < round.plugins.length; left++) {
    if (!changedOf[left]!.size) continue
    for (let right = left + 1; right < round.plugins.length; right++) {
      if (![...changedOf[left]!].some(dep => changedOf[right]!.has(dep))) continue
      parent[find(left)] = find(right)
    }
  }

  const groups = new Map<number, number[]>()
  for (let index = 0; index < round.plugins.length; index++) {
    if (!changedOf[index]!.size) continue
    const root = find(index)
    let group = groups.get(root)
    if (!group) groups.set(root, group = [])
    group.push(index)
  }
  return { closures, groups: [...groups.values()] }
}

function writeRound(round: Round, broken: Set<number>, version = round.version) {
  const { dir, deps } = round
  for (let dep = 0; dep < deps.length; dep++) {
    const header = deps[dep]!.imports
      .map(child => `import { value as d${child} } from './d${child}.ts'`)
      .join('\n')
    // A changed module's new version imports a module that did not exist in the
    // old graph: the import is what puts it in the cache, so a committed unit
    // keeps it and a rolled-back attempt must remove it.
    const fresh = version[dep] === 2
      ? `import { value as f${dep} } from './fresh-${dep}.ts'`
      : ''
    const own = version[dep] === 2 ? `f${dep}` : JSON.stringify(`d${dep}v${version[dep]}`)
    const value = deps[dep]!.imports.length
      ? `${own} + '(' + [${deps[dep]!.imports.map(child => `d${child}`).join(', ')}].join('|') + ')'`
      : own
    const body = broken.has(dep)
      ? `import './fresh-${dep}.ts'\nthrow new Error('broken d${dep}')\n`
      : [
          header,
          fresh,
          '',
          `export const value = ${value}`,
          '',
        ].join('\n')
    writeFileSync(resolve(dir, `d${dep}.ts`), body)
  }
  for (const plugin of round.plugins) {
    const index = round.plugins.indexOf(plugin)
    const imports = plugin.roots
      .map(dep => `import { value as d${dep} } from './d${dep}.ts'`)
      .join('\n')
    const values = plugin.roots.length ? plugin.roots.map(dep => `d${dep}`).join(', ') : "''"
    writeFileSync(resolve(dir, `p${index}.ts`), [
      imports,
      '',
      `export const name = 'p${index}-${round.dir.split(/[\\\\/]/).pop()}'`,
      '',
      'export async function apply(ctx: any) {',
      `  ctx.on('${plugin.event}', () => [${values}].join('+'))`,
      '}',
      '',
    ].join('\n'))
  }
}

function cacheHas(internal: ModuleLoader, url: string) {
  const entry = Map.prototype.get.call(internal.loadCache, url)
  return !!entry && Object.values(entry).some(Boolean)
}

function loadCacheJob(internal: ModuleLoader, url: string) {
  return Map.prototype.get.call(internal.loadCache, url)
}

describe('reconcile runtime properties', () => {
  beforeAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  it(`keeps units independent over ${ROUNDS} generated updates`, async () => {
    for (let roundIndex = 0; roundIndex < ROUNDS; roundIndex++) {
      const seed = (SEED + roundIndex * 0x9e3779b1) >>> 0
      const model = generate(seed)
      const dir = resolve(fixtureRoot, `r${seed.toString(16)}`)
      mkdirSync(dir, { recursive: true })
      const round: Round = { ...model, dir }
      const label = `seed=${seed.toString(16)}`

      // old files: every dependency v1, no failure
      writeRound(round, new Set(), round.version.map(() => 1))
      for (let dep = 0; dep < round.deps.length; dep++) {
        writeFileSync(resolve(dir, `fresh-${dep}.ts`), `export const value = ${JSON.stringify(`d${dep}v2`)}\n`)
      }

      let ctx: Context | undefined
      let loaderFiber: any
      try {
        ctx = new Context()
        loaderFiber = await ctx.plugin(Loader, { baseUrl: pathToFileURL(resolve(dir, 'entry.mjs')).href })
        await ctx.plugin(Hmr)
        const ids: string[] = []
        for (let index = 0; index < round.plugins.length; index++) {
          ids.push(await ctx.loader.create({ name: `./p${index}.ts` }))
          await ctx.loader.store[ids[index]!]!.innerFiber!.await().catch(() => {})
        }

        const oldValues = round.plugins.map(plugin => ctx!.bail(plugin.event) as string)
        for (const [index, value] of oldValues.entries()) {
          expect(value, `${label}: plugin ${index} did not load`).to.be.a('string')
          expect(value, `${label}: plugin ${index} old value`).to.equal(pluginValue(round, round.plugins[index]!, round.version.map(() => 1), new Set()))
        }

        const internal = ctx.loader.internal!
        const beforeJobs = new Map<string, unknown>()
        const watch = (url: string) => beforeJobs.set(url, loadCacheJob(internal, url))
        for (let dep = 0; dep < round.deps.length; dep++) watch(pathToFileURL(resolve(dir, `d${dep}.ts`)).href)
        for (const plugin of round.plugins) watch(plugin.url)

        // new files: changed dependencies bump their version; broken ones import
        // a fresh marker and throw
        writeRound(round, round.broken)
        const changedPaths = [...round.changed].map(dep => resolve(dir, `d${dep}.ts`))
        const result = await ctx.hmr.reconcile({ files: changedPaths })

        const { closures, groups } = componentsOf(round)
        const failedGroups = new Set<number>()
        for (const [groupIndex, group] of groups.entries()) {
          const union = new Set<number>()
          for (const plugin of group) for (const dep of closures[plugin]!) union.add(dep)
          if ([...union].some(dep => round.broken.has(dep))) failedGroups.add(groupIndex)
        }

        const unitOfPlugin = new Map<number, number>()
        for (const [groupIndex, group] of groups.entries()) {
          for (const plugin of group) unitOfPlugin.set(plugin, groupIndex)
        }

        const expected = round.plugins.map((plugin, index) => {
          const group = unitOfPlugin.get(index)
          if (group === undefined) return { stale: false, committed: false, value: oldValues[index]! }
          const committed = !failedGroups.has(group)
          const value = committed
            ? pluginValue(round, plugin, round.version, round.broken)
            : pluginValue(round, plugin, round.version.map(() => 1), new Set())
          expect(value, `${label}: no new value for plugin ${index}`).to.be.a('string')
          return { stale: true, committed, value: value! }
        })

        // 1. the report's units are exactly the connected components
        expect(result.units, `${label}: unit count`).to.have.length(groups.length)
        const reported = new Map<number, Hmr.UnitResult>()
        for (const unit of result.units) {
          for (const entry of unit.entries) {
            const plugin = round.plugins.findIndex(item => item.url === entry)
            expect(plugin, `${label}: unknown entry ${entry}`).to.be.greaterThan(-1)
            expect(reported.has(plugin), `${label}: plugin ${plugin} reported twice`).to.equal(false)
            reported.set(plugin, unit)
          }
        }
        for (const [index, plugin] of round.plugins.entries()) {
          const group = unitOfPlugin.get(index)
          if (group === undefined) {
            expect(reported.has(index), `${label}: unstale plugin ${index} reported`).to.equal(false)
            continue
          }
          const unit = reported.get(index)
          expect(unit, `${label}: plugin ${index} missing from units`).to.be.ok
          const expectedEntries = groups[group]!.map(item => round.plugins[item]!.url).sort()
          expect([...unit!.entries].sort(), `${label}: entries of plugin ${index}`).to.deep.equal(expectedEntries)
          const expectedChanged = [...new Set(groups[group]!.flatMap(item => [...closures[item]!].filter(dep => round.changed.has(dep))))]
            .map(dep => pathToFileURL(resolve(dir, `d${dep}.ts`)).href)
            .sort()
          expect([...unit!.changed].sort(), `${label}: changed of plugin ${index}`).to.deep.equal(expectedChanged)
          if (failedGroups.has(group)) {
            expect(unit!.aborted, `${label}: unit of plugin ${index} did not abort`).to.be.ok
            expect(unit!.replaced, `${label}: aborted unit replaced a fiber`).to.have.length(0)
          } else {
            expect(unit!.aborted, `${label}: committed unit aborted`).to.be.undefined
            expect(unit!.replaced, `${label}: replaced fibers of plugin ${index}`).to.have.length(groups[group]!.length)
          }
        }
        expect(result.aborted ?? [], `${label}: abort count`).to.have.length(failedGroups.size)
        expect(result.replaced.length, `${label}: replaced count`).to.equal(
          round.plugins.filter((_, index) => expected[index]!.committed).length)
        expect(result.failed, `${label}: apply failures`).to.have.length(0)
        expect(result.pending, `${label}: pending changes`).to.deep.equal([])

        // 2. every plugin exposes the value its unit earned
        for (const [index, plugin] of round.plugins.entries()) {
          expect(ctx.bail(plugin.event), `${label}: value of plugin ${index}`).to.equal(expected[index]!.value)
        }

        // 3. a failed unit puts its old jobs back and drops what its attempt
        //    imported; a committed unit keeps the new jobs
        const scopeOf = (group: number) => {
          const scope = new Set<string>()
          const groupClosure = new Set<number>()
          for (const plugin of groups[group]!) {
            scope.add(round.plugins[plugin]!.url)
            for (const dep of closures[plugin]!) groupClosure.add(dep)
          }
          const dependents = new Map<number, number[]>()
          for (let parent = 0; parent < round.deps.length; parent++) {
            for (const child of round.deps[parent]!.imports) {
              if (!groupClosure.has(parent) || !groupClosure.has(child)) continue
              let list = dependents.get(child)
              if (!list) dependents.set(child, list = [])
              list.push(parent)
            }
          }
          const queue = [...round.changed].filter(dep => groupClosure.has(dep))
          while (queue.length) {
            const dep = queue.pop()!
            if (scope.has(pathToFileURL(resolve(dir, `d${dep}.ts`)).href)) continue
            scope.add(pathToFileURL(resolve(dir, `d${dep}.ts`)).href)
            queue.push(...(dependents.get(dep) ?? []))
          }
          return scope
        }

        const inScope = new Map<string, { group: number; failed: boolean }>()
        for (const [group, plugins] of groups.entries()) {
          for (const url of scopeOf(group)) {
            const previous = inScope.get(url)
            expect(previous, `${label}: ${url} is in two unit scopes`).to.be.undefined
            inScope.set(url, { group, failed: failedGroups.has(group) })
          }
        }

        for (let dep = 0; dep < round.deps.length; dep++) {
          const url = pathToFileURL(resolve(dir, `d${dep}.ts`)).href
          const scope = inScope.get(url)
          const after = loadCacheJob(internal, url)
          if (!scope) {
            expect(after, `${label}: unreached d${dep} lost its job`).to.equal(beforeJobs.get(url))
          } else if (scope.failed) {
            expect(after, `${label}: aborted d${dep} was not restored`).to.equal(beforeJobs.get(url))
          } else {
            expect(after, `${label}: committed d${dep} kept its old job`).to.not.equal(beforeJobs.get(url))
          }

          const marker = pathToFileURL(resolve(dir, `fresh-${dep}.ts`)).href
          if (!round.changed.has(dep)) {
            expect(cacheHas(internal, marker), `${label}: untouched d${dep} imported its marker`).to.equal(false)
          } else if (scope?.failed) {
            expect(cacheHas(internal, marker), `${label}: aborted d${dep} left its marker cached`).to.equal(false)
          } else {
            expect(cacheHas(internal, marker), `${label}: committed d${dep} lost its marker`).to.equal(true)
          }
        }

        for (const [index, plugin] of round.plugins.entries()) {
          const after = loadCacheJob(internal, plugin.url)
          const expectedState = expected[index]!
          if (!expectedState.stale) {
            expect(after, `${label}: unstale plugin ${index} lost its job`).to.equal(beforeJobs.get(plugin.url))
          } else if (expectedState.committed) {
            expect(after, `${label}: committed plugin ${index} kept its old job`).to.not.equal(beforeJobs.get(plugin.url))
          } else {
            expect(after, `${label}: aborted plugin ${index} was not restored`).to.equal(beforeJobs.get(plugin.url))
          }
        }
      } finally {
        await loaderFiber?.dispose()
      }
    }
  }, 180000)

  it('drops what a merged unit imported before that unit fails', async () => {
    // Two changed sets that do not overlap, so `groupUnits` keeps them apart:
    // A changes its plugin and a module it shares with nobody, B changes its
    // own dependency and a module that throws. A's new version imports a
    // module of B's scope and a brand-new module, so stage 1 merges the two
    // attempts when they meet. B's failure then aborts the merged unit, and
    // the module A's new version introduced must leave the cache with it —
    // `restore` only knows the modules the units evicted, not what an attempt
    // added.
    const dir = resolve(fixtureRoot, 'merged')
    mkdirSync(dir, { recursive: true })
    const write = (name: string, content: string) => writeFileSync(resolve(dir, name), content)
    const value = (text: string) => `export const value = '${text}'\n`

    const aOld = `
import { value as shared } from './shared.ts'

export const name = 'a'

export async function apply(ctx: any) {
  ctx.on('merged/a', () => shared)
}
`
    const aNew = `
import { value as shared } from './shared.ts'
import { value as fresh } from './fresh.ts'
import { value as dep } from './dep-b.ts'

export const name = 'a'

export async function apply(ctx: any) {
  ctx.on('merged/a', () => [shared, fresh, dep].join('+'))
}
`
    const b = `
import { value as dep } from './dep-b.ts'
import { broken } from './broken.ts'

export const name = 'b'

export async function apply(ctx: any) {
  ctx.on('merged/b', () => dep + '+' + broken)
}
`

    write('shared.ts', value('s1'))
    write('dep-b.ts', value('b1'))
    write('broken.ts', `export const broken = 'ok'\n`)
    write('a.ts', aOld)
    write('b.ts', b)

    let ctx: Context | undefined
    let loaderFiber: any
    try {
      ctx = new Context()
      loaderFiber = await ctx.plugin(Loader, { baseUrl: pathToFileURL(resolve(dir, 'entry.mjs')).href })
      await ctx.plugin(Hmr)
      const load = async (name: string) => {
        await ctx!.loader.create({ name })
        await ctx!.loader.await()
      }
      await load('./a.ts')
      await load('./b.ts')
      expect(ctx.bail('merged/a')).to.equal('s1')
      expect(ctx.bail('merged/b')).to.equal('b1+ok')

      const internal = ctx.loader.internal!
      const url = (name: string) => pathToFileURL(resolve(dir, name)).href
      const watched = ['shared.ts', 'dep-b.ts', 'broken.ts', 'a.ts', 'b.ts']
      const before = new Map(watched.map(name => [name, loadCacheJob(internal, url(name))]))

      write('shared.ts', value('s2'))
      write('dep-b.ts', value('b2'))
      write('fresh.ts', value('f1'))
      write('broken.ts', `throw new Error('broken')\n`)
      write('a.ts', aNew)
      const result = await ctx.hmr.reconcile({ files: watched.map(name => url(name)) })

      expect(result.units, 'the attempts meet on dep-b, so they are one unit').to.have.length(1)
      expect(result.replaced, 'an aborted unit replaces nothing').to.have.length(0)
      expect(result.aborted, 'the unit aborts once').to.have.length(1)
      expect(ctx.bail('merged/a'), 'the successful attempt is rolled back too').to.equal('s1')
      expect(ctx.bail('merged/b'), 'the failing plugin keeps its old value').to.equal('b1+ok')
      expect(cacheHas(internal, url('fresh.ts')), 'the new module outlived the rollback').to.equal(false)
      for (const name of watched) {
        expect(loadCacheJob(internal, url(name)), `${name} was not restored`).to.equal(before.get(name))
      }
    } finally {
      await loaderFiber?.dispose()
    }
  }, 60000)
})