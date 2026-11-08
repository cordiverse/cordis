import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getModuleJobs, ModuleJob, ModuleLoader, ModuleStatus } from './internal.ts'

// a builtin has no file and no dependencies to follow
function isBuiltin(url: string) {
  return url.startsWith('node:')
}

function toPath(url: string) {
  if (url.startsWith('file:')) return fileURLToPath(url)
}

/**
 * The modules that Node has loaded, in its ESM load cache and its CJS module
 * cache. A module is identified by its URL. A CJS module imported through
 * `import()` is in both caches under the URL of its file.
 *
 * The load cache is a `LoadCache`, whose entries are `{ [type]: ModuleJob }`,
 * one job per value of the `type` import attribute. Its own `delete(url)` only
 * clears the `javascript` slot and keeps the entry. `LoadCache` extends Node's
 * internal `SafeMap`, which carries the Map internal slots, so the methods of
 * `Map.prototype` apply to whole entries although `loadCache instanceof Map`
 * is false.
 */
export class ModuleCaches {
  private _cjs = createRequire(import.meta.url).cache

  constructor(private _loader: ModuleLoader) {}

  /** Whether a module is loaded under `url` in either cache. */
  has(url: string) {
    if (Map.prototype.has.call(this._loader.loadCache, url)) return true
    const path = toPath(url)
    return !!path && path in this._cjs
  }

  /** The URLs of the loaded modules, in either cache. */
  urls() {
    const urls = new Set(Map.prototype.keys.call(this._loader.loadCache) as Iterable<string>)
    for (const path of Object.keys(this._cjs)) urls.add(pathToFileURL(path).href)
    return urls
  }

  /**
   * The namespace of the module job of `url` imported without the `type`
   * attribute, or `undefined` if there is no such job, it has not been
   * instantiated, or its evaluation failed.
   */
  namespace(url: string): unknown {
    const module = this._loader.loadCache.get(url)?.module
    if (!module || module.getStatus() === ModuleStatus.Errored) return
    try {
      return module.getNamespace()
    } catch {
      // a module that has not been instantiated has no namespace
    }
  }

  /**
   * The exports of the CJS module of `url`, or `undefined` if there is no
   * such module or it has not finished loading.
   */
  exports(url: string): unknown {
    const path = toPath(url)
    const module = path ? this._cjs[path] : undefined
    if (module?.loaded) return module.exports
  }

  /**
   * The direct dependencies of a module: the modules linked by its module
   * jobs in every type slot, and the children of its CJS module. A job that
   * failed to link contributes no dependencies.
   */
  async edges(url: string) {
    const edges = new Set<string>()
    await Promise.all(getModuleJobs(this._loader.loadCache, url).map(async (job) => {
      let linked: ModuleJob[]
      try {
        linked = Array.from(await job.linked)
      } catch {
        return
      }
      for (const child of linked) edges.add(child.url)
    }))
    for (const child of this.children(url)) edges.add(child)
    return edges
  }

  /** The URLs of the children of the CJS module of `url`. */
  children(url: string) {
    const path = toPath(url)
    return ((path && this._cjs[path]?.children) || []).map(child => pathToFileURL(child.filename).href)
  }

  /**
   * Remove the module jobs that failed to load, link or evaluate, each from
   * its own type slot, so that the next import of their modules tries again.
   * Node keeps such a job in the load cache, and every later import of the
   * module throws its error again. A job in progress has not failed and is
   * kept. The CJS module cache is left alone: Node removes a CJS module whose
   * evaluation failed.
   *
   * A job has failed if its module is errored, or if its `modulePromise`,
   * `linked` or `instantiated` promise has been rejected. A promise that has
   * settled runs its handlers before the next macrotask.
   */
  async sweep() {
    interface ModuleCheck {
      url: string
      entry: Record<string, ModuleJob | undefined>
      type: string
      job: ModuleJob
      failed: boolean
    }
    const loadCache = this._loader.loadCache
    const checks: ModuleCheck[] = []
    for (const url of Map.prototype.keys.call(loadCache) as Iterable<string>) {
      if (isBuiltin(url)) continue
      const entry: Record<string, ModuleJob | undefined> = Map.prototype.get.call(loadCache, url)
      for (const type in entry) {
        const job = entry[type]
        if (!job) continue
        const check = { url, entry, type, job, failed: job.module?.getStatus() === ModuleStatus.Errored }
        for (const promise of [job.modulePromise, job.linked, job.instantiated]) {
          if (!promise || Array.isArray(promise)) continue
          promise.then(undefined, () => check.failed = true)
        }
        checks.push(check)
      }
    }
    await new Promise(resolve => setImmediate(resolve))
    for (const { url, entry, type, job, failed } of checks) {
      if (!failed || entry[type] !== job) continue
      delete entry[type]
      if (!Object.values(entry).some(Boolean)) {
        Map.prototype.delete.call(loadCache, url)
      }
    }
  }

  /**
   * Remove modules from both caches, so that their next import evaluates
   * their files again. Existing references keep the old instances.
   * @returns a backup of the removed entries
   */
  evict(urls: Iterable<string>): ModuleBackup {
    const esm = new Map<string, unknown>()
    const cjs = new Map<string, NodeJS.Module>()
    for (const url of urls) {
      const entry = Map.prototype.get.call(this._loader.loadCache, url)
      if (entry) esm.set(url, entry)
      const path = toPath(url)
      if (path && this._cjs[path]) cjs.set(path, this._cjs[path])
      this._delete(url)
    }
    return {
      restore: (urls) => {
        for (const url of urls) {
          this._delete(url)
          if (esm.has(url)) Map.prototype.set.call(this._loader.loadCache, url, esm.get(url))
          const path = toPath(url)
          if (path && cjs.has(path)) this._cjs[path] = cjs.get(path)
        }
      },
    }
  }

  private _delete(url: string) {
    Map.prototype.delete.call(this._loader.loadCache, url)
    const path = toPath(url)
    if (path) delete this._cjs[path]
  }
}

/** The entries removed by {@link ModuleCaches.evict}. */
export interface ModuleBackup {
  /**
   * Put the removed entries of `urls` back in place of the current ones. A
   * module that was not loaded when it was evicted is removed again.
   */
  restore(urls: Iterable<string>): void
}
