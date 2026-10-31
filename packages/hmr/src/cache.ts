import type { ModuleLoader } from '@cordisjs/loader-utils'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'

const require = createRequire(import.meta.url)

function toPath(url: string) {
  try {
    const path = fileURLToPath(url)
    if (require.cache[path]) return path
    try {
      const real = fs.realpathSync(path)
      if (require.cache[real]) return real
    } catch {}
    return path
  } catch {
    return undefined
  }
}

/** An edge cut from a parent's `children`, with the position it had there. */
interface CutEdge {
  parent: NodeJS.Module
  child: NodeJS.Module
  index: number
}

/** Every module in the CJS cache, as `file:` URLs. */
export function cjsUrls(): string[] {
  return Object.keys(require.cache).map(path => pathToFileURL(path).href)
}

/** Whether the module at `url` is loaded in the CJS cache. */
export function cjsHas(url: string) {
  const path = toPath(url)
  return !!path && !!require.cache[path]
}

/** The dependencies of the CJS module at `url`, as `file:` URLs. */
export function cjsChildren(url: string): string[] {
  const path = toPath(url)
  const children = (path && require.cache[path]?.children) || []
  return children.map(child => pathToFileURL(child.filename).href)
}

/**
 * Evicts modules from both module caches for the duration of a transaction,
 * and puts back the ones whose unit aborted.
 *
 * The two systems record an edge differently. The ESM loader keeps a module's
 * static imports in `linked`, so dropping its `loadCache` entry cuts them all
 * at once. A CJS module is instead listed in its parents' `children` arrays,
 * and deleting `require.cache[path]` leaves those entries behind: the evicted
 * instance stays reachable through the reverse dependency graph, which is what
 * `Hmr#_edges` and `Hmr#_analyze` read. They are cut here in one reverse scan.
 *
 * Only the edges that were actually cut are recorded, each with its position,
 * so that `restore` can put them back one by one. Replacing a parent's whole
 * array from a snapshot would also drop the children a parent gained while the
 * transaction was importing.
 */
export class ModuleCache {
  private esmBackup: Record<string, unknown> = Object.create(null)
  private cjsBackup: Record<string, NodeJS.Module> = Object.create(null)
  private cuts: CutEdge[] = []

  constructor(private internal: ModuleLoader) {}

  evict(urls: Iterable<string>) {
    const childMods = new Set<NodeJS.Module>()
    const paths = new Set<string>()
    for (const url of urls) {
      if (!(url in this.esmBackup)) {
        this.esmBackup[url] = Map.prototype.get.call(this.internal.loadCache, url)
      }
      Map.prototype.delete.call(this.internal.loadCache, url)

      const path = toPath(url)
      if (!path) continue
      if (require.cache[path]) {
        const mod = require.cache[path]!
        this.cjsBackup[path] ??= mod
        childMods.add(mod)
        paths.add(path)
      }
    }
    if (!childMods.size) return

    // Collect all unique parents: cached CJS parents and any uncached parents (e.g. ESM callers)
    const parents = new Set<NodeJS.Module>()
    for (const key of Object.keys(require.cache)) {
      const p = require.cache[key]
      if (p) parents.add(p)
    }
    for (const child of childMods) {
      if (child.parent) parents.add(child.parent)
    }

    // Cut every edge in reverse scan so indices are stable during splicing
    for (const parent of parents) {
      for (let i = parent.children.length - 1; i >= 0; i--) {
        const child = parent.children[i]
        if (!child || !childMods.has(child)) continue
        this.cuts.push({ parent, child, index: i })
        parent.children.splice(i, 1)
      }
    }

    for (const path of paths) {
      delete require.cache[path]
    }
  }

  /**
   * Put back the recorded state of `urls`, which are the evicted modules of the
   * units that aborted. A parent gets back exactly the edges it had for those
   * modules, at the position they were in, and keeps every other entry it holds
   * by then — the ones of the modules that stay evicted are already gone.
   *
   * Calls accumulate: the modules restored by an earlier call stay restored.
   */
  restore(urls: Iterable<string>) {
    const restoreMods = new Set<NodeJS.Module>()
    const paths = new Set<string>()
    for (const url of urls) {
      Map.prototype.delete.call(this.internal.loadCache, url)
      const job = this.esmBackup[url]
      if (job) Map.prototype.set.call(this.internal.loadCache, url, job)

      const path = toPath(url)
      if (!path) continue
      paths.add(path)
      if (this.cjsBackup[path]) {
        const mod = this.cjsBackup[path]!
        require.cache[path] = mod
        restoreMods.add(mod)
      }
    }
    if (!restoreMods.size) return

    // ascending, so that several edges of one parent land where they were
    const back = this.cuts
      .filter(cut => restoreMods.has(cut.child))
      .sort((a, b) => a.index - b.index)
    for (const cut of back) {
      // Defensive safeguard: ensure parent has not disposed of this child reference path
      // and index is valid.
      const index = Math.min(cut.index, cut.parent.children.length)
      if (!cut.parent.children.includes(cut.child)) {
        cut.parent.children.splice(index, 0, cut.child)
      }
    }
    this.cuts = this.cuts.filter(cut => !restoreMods.has(cut.child))
  }
}
