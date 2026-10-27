import type { Plugin } from 'cordis'

/** One plugin whose module changed, with everything the reload needs. */
export interface Stale {
  /** the module the plugin is reloaded from */
  url: string
  /** every module that exports this plugin */
  urls: string[]
  plugin: Plugin
  runtime: Plugin.Runtime
  /** the dependency closure of `urls`, widened over the CJS edges */
  closure: Set<string>
  /** the changed files inside the closure — what this reload answers for */
  changed: Set<string>
  /** module → the closure members that depend on it, over both edge kinds */
  dependents: Map<string, Set<string>>
}

/**
 * One atomic batch of the transaction: the plugins it reloads, the modules it
 * evicts, and the changed files it answers for.
 */
export interface Unit {
  plugins: Pick<Stale, 'url' | 'urls' | 'plugin' | 'runtime'>[]
  /** every module this unit evicts */
  scope: Set<string>
  /** the changed files inside this unit's closures */
  changed: Set<string>
}

/**
 * Group the stale plugins into units. Two plugins share a unit when the
 * changed files they answer for overlap: a shared dependency that breaks
 * serves its new version to both, so they stand and fall together.
 *
 * The grouping is equivalent to the one the overlap of the evicted sets
 * describes. Write S(F) for the modules of F's closure that a change reaches
 * — `accepted` holds exactly those, since a module is accepted when it is
 * changed or depends on an accepted module. If a module sits in two closures,
 * every dependency of it sits in both closures as well, so the changed file
 * that put it in `accepted` puts the same file in both changed sets. Sharing
 * an unchanged module therefore never merges two units: nothing changed
 * reaches it, so it is in neither `accepted` nor any changed set.
 */
export function groupUnits(stales: Stale[]): Unit[] {
  const parent = stales.map((_, index) => index)
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]]!
      index = parent[index]!
    }
    return index
  }

  // a changed file joins the stales that answer for it
  const owners = new Map<string, number>()
  for (const [index, stale] of stales.entries()) {
    for (const url of stale.changed) {
      const owner = owners.get(url)
      if (owner === undefined) owners.set(url, index)
      else parent[find(index)] = find(owner)
    }
  }

  const groups = new Map<number, Stale[]>()
  for (const [index, stale] of stales.entries()) {
    const root = find(index)
    let group = groups.get(root)
    if (!group) groups.set(root, group = [])
    group.push(stale)
  }

  return [...groups.values()].map((group) => {
    const dependents = new Map<string, Set<string>>()
    for (const stale of group) {
      for (const [url, parents] of stale.dependents) {
        let merged = dependents.get(url)
        if (!merged) dependents.set(url, merged = new Set())
        for (const parent of parents) merged.add(parent)
      }
    }
    const changed = new Set(group.flatMap(stale => [...stale.changed]))
    return {
      plugins: group.map(stale => ({ url: stale.url, urls: stale.urls, plugin: stale.plugin, runtime: stale.runtime })),
      scope: scopeOf(group, changed, dependents),
      changed,
    }
  })
}

/**
 * The modules a unit evicts: the modules its plugins load from, the changed
 * files it answers for, and every module a change reaches on its way up to
 * them. A module nothing reached keeps its place — none of its dependencies
 * moved, so its evaluation result is still what the disk holds, and
 * re-evaluating it would only run its top-level effects a second time.
 *
 * The walk only follows edges inside the closures, so it cannot leave them.
 * Units whose changed files are disjoint evict disjoint modules: a module in
 * two scopes would reach both units' changed files through its dependencies,
 * and every dependency of a closure member is a closure member too, so each
 * of those files would sit in both closures — which is exactly what merges
 * the two units into one. One unit's rollback therefore cannot touch
 * another's modules.
 */
function scopeOf(group: Stale[], changed: Set<string>, dependents: Map<string, Set<string>>) {
  const scope = new Set<string>()
  for (const stale of group) {
    for (const url of stale.urls) scope.add(url)
  }
  const queue = [...changed]
  while (queue.length) {
    const url = queue.pop()!
    if (scope.has(url)) continue
    scope.add(url)
    for (const parent of dependents.get(url) ?? []) queue.push(parent)
  }
  return scope
}

/** Whether two units share an evicted module — the property rollback relies on. */
export function scopesOverlap(a: Unit, b: Unit) {
  for (const url of a.scope) {
    if (b.scope.has(url)) return true
  }
  return false
}
