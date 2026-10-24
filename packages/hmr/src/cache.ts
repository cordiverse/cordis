import type { Dict } from 'cosmokit'
import type { ModuleLoader } from '@cordisjs/plugin-loader'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

function toPath(url: string) {
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

// The CJS module at `url`, or undefined when the URL holds no file or the
// module was never required.
function module(url: string) {
  const path = toPath(url)
  if (!path) return undefined
  return require.cache[path]
}

// The dependencies of the CJS module at `url`, as `file:` URLs. A CJS module
// resolves them through `require`, which leaves them in `children` — the only
// record of the edge, since the ESM linker does not see it.
export function cjsChildren(url: string): string[] {
  const mod = module(url)
  // an entry can exist without `children`: a JSON module imported through the
  // ESM loader leaves one, and so may a host that mixes the two systems
  if (!mod?.children) return []
  return mod.children.map(child => pathToFileURL(child.filename).href)
}

// Whether the module at `url` is loaded in the CJS cache.
export function cjsHas(url: string) {
  return !!module(url)
}

// Every module in the CJS cache, as `file:` URLs.
export function cjsUrls() {
  return Object.keys(require.cache).map(path => pathToFileURL(path).href)
}

/**
 * Clears both module caches for a batch of modules, and puts them back when
 * the transaction aborts.
 *
 * The two systems record an edge differently. The ESM loader keeps a module's
 * static imports in `linked`, so deleting the `loadCache` entry cuts them all
 * at once. A CJS module's dependencies live in its parents' `children` arrays
 * instead, so an evicted module stays reachable through them until it is
 * unlinked — hence the reverse scan over `children`, which is the reverse
 * dependency graph of the CJS side.
 *
 * Each `evict` call names its owner, and `restore` puts back one owner's
 * modules alone: the units of a batch evict disjoint modules, so one unit's
 * rollback cannot touch another's.
 */
export class ModuleCache {
  private backups = new Map<object, { esm: Dict; cjs: Dict; children: Dict; paths: Set<string> }>()

  constructor(private internal: ModuleLoader) {}

  evict(urls: Iterable<string>, owner: object) {
    let backup = this.backups.get(owner)
    if (!backup) {
      this.backups.set(owner, backup = {
        esm: Object.create(null),
        cjs: Object.create(null),
        children: Object.create(null),
        paths: new Set(),
      })
    }

    const paths = new Set<string>()
    for (const url of urls) {
      const job = Map.prototype.get.call(this.internal.loadCache, url)
      backup.esm[url] = job
      Map.prototype.delete.call(this.internal.loadCache, url)

      const path = toPath(url)
      if (path && require.cache[path]) {
        backup.cjs[path] = require.cache[path]
        paths.add(path)
      }
    }
    if (!paths.size) return

    // one reverse scan cuts every edge at once
    for (const key of Object.keys(require.cache)) {
      if (paths.has(key)) continue
      const parent = require.cache[key]
      if (!parent) continue
      let cut = false
      for (let i = parent.children.length - 1; i >= 0; i--) {
        const child = parent.children[i]
        if (!child || !paths.has(child.filename)) continue
        if (!cut) {
          backup.children[key] = parent.children.slice()
          cut = true
        }
        parent.children.splice(i, 1)
      }
    }
    for (const path of paths) {
      backup.paths.add(path)
      delete require.cache[path]
    }
  }

  // Drops what a unit's own import added to the caches. A failed import can
  // leave jobs behind for modules the new version introduced — they are not in
  // any scope, so `restore` does not know them, and the state after a rollback
  // would not be the state before the attempt.
  discard(urls: Iterable<string>) {
    for (const url of urls) {
      Map.prototype.delete.call(this.internal.loadCache, url)
      const path = toPath(url)
      if (path) delete require.cache[path]
    }
  }

  // Drops every backup: a committed transaction never restores, and the
  // modules it evicted are reachable through the backup until it goes.
  clear() {
    this.backups.clear()
  }

  restore(owner: object) {
    const backup = this.backups.get(owner)
    if (!backup) return
    // handed back below; keeping it would retain the evicted jobs and modules
    this.backups.delete(owner)
    for (const url in backup.esm) {
      Map.prototype.set.call(this.internal.loadCache, url, backup.esm[url])
    }
    for (const path in backup.cjs) {
      require.cache[path] = backup.cjs[path]
    }
    // A parent can hold modules of several units — it is in none of their
    // scopes, so each unit cut its own edge from the same array. Putting the
    // whole snapshot back would restore the edges another unit cut, so only
    // this unit's edges go back, at the positions they held.
    for (const path in backup.children) {
      const parent = require.cache[path]
      if (!parent) continue
      const before = backup.children[path] as any[]
      const current = new Set(parent.children.map(child => child.filename))
      for (let index = 0; index < before.length; index++) {
        const child = before[index]
        if (!backup.paths.has(child.filename) || current.has(child.filename)) continue
        parent.children.splice(index, 0, child)
        current.add(child.filename)
      }
    }
  }
}
