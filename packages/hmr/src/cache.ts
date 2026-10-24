import { Dict } from 'cosmokit'
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
  if (!mod) return []
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
 */
export class ModuleCache {
  private esmBackup: Dict = Object.create(null)
  private cjsBackup: Dict = Object.create(null)
  private childrenBackup: Dict = Object.create(null)

  constructor(private internal: ModuleLoader) {}

  evict(urls: Iterable<string>) {
    const paths = new Set<string>()
    for (const url of urls) {
      const job = Map.prototype.get.call(this.internal.loadCache, url)
      this.esmBackup[url] = job
      Map.prototype.delete.call(this.internal.loadCache, url)

      const path = toPath(url)
      if (path && require.cache[path]) {
        this.cjsBackup[path] = require.cache[path]
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
          this.childrenBackup[key] = parent.children.slice()
          cut = true
        }
        parent.children.splice(i, 1)
      }
    }
    for (const path of paths) {
      delete require.cache[path]
    }
  }

  restore() {
    for (const url in this.esmBackup) {
      Map.prototype.set.call(this.internal.loadCache, url, this.esmBackup[url])
    }
    for (const path in this.cjsBackup) {
      require.cache[path] = this.cjsBackup[path]
    }
    for (const path in this.childrenBackup) {
      const parent = require.cache[path]
      if (parent) parent.children = this.childrenBackup[path]
    }
  }
}
