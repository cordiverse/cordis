/**
 * Property tests for `groupUnits`, covering issue #243 item 4: a reload is
 * split into units, the split must be the connected components of the
 * changed-set overlap, and different units must evict disjoint module sets so
 * one unit's rollback cannot touch another's modules.
 *
 * Four theorems are checked over randomly generated dependency graphs:
 *
 * 1. partition — two stales share a unit iff a chain of pairwise intersecting
 *    `changed` sets links them. An independent union-find oracle computes the
 *    components; only the induced equivalence relation is compared, never the
 *    order of the units.
 * 2. disjointness — `scopesOverlap` is false for every pair of distinct units.
 * 3. minimality — a module that no change reaches stays out of every scope: it
 *    is in no `changed` set, in no `urls`, and does not transitively depend on
 *    a changed module (reverse reachability over `dependents`).
 * 4. coverage — every unit's scope contains all of its plugins' `urls`.
 *
 * The generator models the pipeline that feeds `groupUnits`, which constrains
 * what counts as a legal input:
 *
 * - `changed` is `C ∩ closure` for one global changed set `C`. A changed file
 *   inside a closure always lands in that stale's `changed` set, so two stales
 *   whose closures share a changed file necessarily share it in `changed` too.
 *   Picking an independent random subset per stale instead breaks theorem 2
 *   without any implementation bug: take closures `{p1, s}` and `{p2, s, b}`
 *   with `s` depending on `b`, `changed` `{s}` and `{b}`. The sets are disjoint
 *   so the stales stay apart, yet `s` is in both scopes — an input the real
 *   pipeline cannot produce, because `s` being changed and inside the second
 *   closure forces `s ∈ changed` there, which merges the two.
 * - `urls` are disjoint across stales: distinct plugins are exported by
 *   distinct module sets, so no scope can pick up another unit's entry point.
 * - `dependents` only holds edges whose endpoints both sit in the closure, and
 *   the closure is closed under dependencies, matching how the real reloader
 *   records reverse edges.
 *
 * These are the preconditions the proofs in `src/unit.ts` rely on; the tests
 * assert them on every generated graph so a failure is never blamed on an
 * illegal input.
 */
import { describe, expect, it } from 'vitest'
import { groupUnits, scopesOverlap, type Stale, type Unit } from '../src/unit.ts'

const SEED = 0x2f6e2b1
const ROUNDS = 200

/** Deterministic PRNG, so a failing round can be replayed from its seed. */
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

interface Graph {
  /** every module name, changed or not */
  modules: string[]
  /** `[dependent, dependency]` over the whole graph */
  edges: [string, string][]
  /** the changed files on disk — each stale answers for `changed ∩ closure` */
  changed: Set<string>
  stales: Stale[]
}

/** The modules reachable from `roots` along `edges` (dependency closure). */
function closureOf(roots: string[], edges: [string, string][]) {
  const closure = new Set(roots)
  const queue = [...roots]
  while (queue.length) {
    const url = queue.pop()!
    for (const [parent, child] of edges) {
      if (parent !== url || closure.has(child)) continue
      closure.add(child)
      queue.push(child)
    }
  }
  return closure
}

function generate(seed: number): Graph {
  const random = mulberry32(seed)
  const int = (bound: number) => Math.floor(random() * bound)
  const count = 12 + int(9)
  const modules = Array.from({ length: count }, (_, index) => `m${index}`)

  // `a → b` means a depends on b; edges only go from a higher index to a lower
  // one, so the graph is acyclic and every closure is finite
  const edges: [string, string][] = []
  for (let hi = 1; hi < count; hi++) {
    for (let lo = 0; lo < hi; lo++) {
      if (random() < 0.12) edges.push([modules[hi]!, modules[lo]!])
    }
  }

  // entry points are disjoint across stales, as distinct plugins are exported
  // by distinct module sets
  const pool = [...modules]
  for (let index = pool.length - 1; index > 0; index--) {
    const swap = int(index + 1)
    ;[pool[index], pool[swap]] = [pool[swap]!, pool[index]!]
  }
  const staleCount = 1 + int(4)
  const urlSets: string[][] = []
  let cursor = 0
  for (let index = 0; index < staleCount; index++) {
    const size = 1 + int(2)
    urlSets.push(pool.slice(cursor, cursor + size))
    cursor += size
  }

  const changed = new Set(modules.filter(() => random() < 0.3))

  const stales = urlSets.map((urls): Stale => {
    const closure = closureOf(urls, edges)
    const dependents = new Map<string, Set<string>>()
    for (const [parent, child] of edges) {
      if (!closure.has(parent) || !closure.has(child)) continue
      let parents = dependents.get(child)
      if (!parents) dependents.set(child, parents = new Set())
      parents.add(parent)
    }
    return {
      url: urls[0]!,
      urls,
      plugin: undefined as any,
      runtime: undefined as any,
      closure,
      changed: new Set([...closure].filter(url => changed.has(url))),
      dependents,
    }
  })

  return { modules, edges, changed, stales }
}

/** Guard: the generator must only ever hand `groupUnits` legal input. */
function expectWellFormed({ modules, changed, stales }: Graph, seed: number) {
  const entries = new Set<string>()
  for (const stale of stales) {
    for (const url of stale.urls) {
      expect(stale.closure.has(url), `seed=${seed}: entry ${url} outside its closure`).to.equal(true)
      expect(entries.has(url), `seed=${seed}: ${url} is an entry of two stales`).to.equal(false)
      entries.add(url)
    }
    for (const url of stale.changed) {
      expect(stale.closure.has(url), `seed=${seed}: changed ${url} outside its closure`).to.equal(true)
      expect(changed.has(url), `seed=${seed}: ${url} changed but not on disk`).to.equal(true)
    }
    for (const [child, parents] of stale.dependents) {
      expect(stale.closure.has(child), `seed=${seed}: dependent key ${child} outside the closure`).to.equal(true)
      for (const parent of parents) {
        expect(stale.closure.has(parent), `seed=${seed}: dependent ${parent} outside the closure`).to.equal(true)
      }
    }
    // the closure is dependency-closed, so no edge leaves it
    for (const url of stale.closure) {
      expect(modules.includes(url), `seed=${seed}: unknown module ${url}`).to.equal(true)
    }
  }
}

/** Oracle: connected components of the "changed sets intersect" relation. */
function components(stales: Stale[]) {
  const parent = stales.map((_, index) => index)
  const find = (index: number): number => {
    while (parent[index] !== index) index = parent[index] = parent[parent[index]!]!
    return index
  }
  for (let left = 0; left < stales.length; left++) {
    for (let right = left + 1; right < stales.length; right++) {
      const shared = [...stales[left]!.changed].some(url => stales[right]!.changed.has(url))
      if (shared) parent[find(right)] = find(left)
    }
  }
  return stales.map((_, index) => find(index))
}

/** Reverse reachability from `roots` over the union of every stale's edges. */
function reverseReach(stales: Stale[], roots: Set<string>) {
  const dependents = new Map<string, Set<string>>()
  for (const stale of stales) {
    for (const [url, parents] of stale.dependents) {
      let merged = dependents.get(url)
      if (!merged) dependents.set(url, merged = new Set())
      for (const parent of parents) merged.add(parent)
    }
  }
  const reached = new Set(roots)
  const queue = [...roots]
  while (queue.length) {
    const url = queue.pop()!
    for (const parent of dependents.get(url) ?? []) {
      if (reached.has(parent)) continue
      reached.add(parent)
      queue.push(parent)
    }
  }
  return reached
}

function unitOfPlugin(units: Unit[]) {
  const map = new Map<string, number>()
  for (const [index, unit] of units.entries()) {
    for (const plugin of unit.plugins) map.set(plugin.url, index)
  }
  return map
}

describe('groupUnits properties', () => {
  it(`holds the four theorems over ${ROUNDS} random graphs`, () => {
    for (let round = 0; round < ROUNDS; round++) {
      const seed = (SEED + round * 0x9e3779b1) >>> 0
      const graph = generate(seed)
      const { stales } = graph
      expectWellFormed(graph, seed)
      const units = groupUnits(stales)
      const label = `seed=${seed}`
      const indexOf = new Map(stales.map((stale, index) => [stale.url, index]))

      // 1. the partition is the connected components of the changed overlap
      const oracle = components(stales)
      const unitOf = unitOfPlugin(units)
      expect(units.reduce((sum, unit) => sum + unit.plugins.length, 0), label).to.equal(stales.length)
      for (let left = 0; left < stales.length; left++) {
        for (let right = left + 1; right < stales.length; right++) {
          const expected = oracle[left] === oracle[right]
          const actual = unitOf.get(stales[left]!.url) === unitOf.get(stales[right]!.url)
          expect(actual, `${label}: ${stales[left]!.url} vs ${stales[right]!.url}`).to.equal(expected)
        }
      }

      // 2. two units never evict the same module
      for (const [index, unit] of units.entries()) {
        for (const other of units.slice(index + 1)) {
          expect(scopesOverlap(unit, other), `${label}: ${unit.plugins[0]!.url} vs ${other.plugins[0]!.url}`)
            .to.equal(false)
        }
      }

      // 3. a module no change reaches stays out of every scope
      const changedUrls = new Set<string>()
      const entryUrls = new Set<string>()
      for (const stale of stales) {
        for (const url of stale.changed) changedUrls.add(url)
        for (const url of stale.urls) entryUrls.add(url)
      }
      const reachable = reverseReach(stales, changedUrls)
      for (const unit of units) {
        for (const url of unit.scope) {
          const exempt = entryUrls.has(url) || reachable.has(url)
          expect(exempt, `${label}: ${url} evicted without a change reaching it`).to.equal(true)
        }
      }

      // 4. every entry point of a unit is inside that unit's scope
      for (const unit of units) {
        for (const plugin of unit.plugins) {
          for (const url of plugin.urls) {
            expect(unit.scope.has(url), `${label}: ${url} missing from the scope of ${plugin.url}`).to.equal(true)
          }
        }
      }

      // sanity: every plugin in a unit is a stale, and vice versa
      for (const plugin of units.flatMap(unit => unit.plugins)) {
        expect(indexOf.has(plugin.url), `${label}: ${plugin.url} is not a stale`).to.equal(true)
      }
    }
  })
})
