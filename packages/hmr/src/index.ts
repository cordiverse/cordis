import { Context, Fiber, Plugin, Service } from 'cordis'
import { getModuleJobs, ModuleJob, ModuleLoader, ModuleStatus, unwrapExports } from '@cordisjs/loader-utils'
import type {} from '@cordisjs/plugin-fs-node'
import { AsyncLocalStorage } from 'node:async_hooks'
import { relative, resolve, sep } from 'node:path'
import { handleError } from './error.ts'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import picomatch from 'picomatch'
import z from 'schemastery'

declare module 'cordis' {
  interface Context {
    hmr: Hmr
  }
}

// A Windows drive-letter path, e.g. `C:\app\cordis.yml` or `C:/app/cordis.yml`.
const driveLetter = /^[A-Za-z]:[\\/]/

// a builtin has no file and no dependencies to follow
function isBuiltin(url: string) {
  return url.startsWith('node:')
}

// A native addon cannot be loaded again in the same process: requiring its
// file once more returns the library that is already loaded.
function isNativeAddon(url: string) {
  return url.startsWith('file:') && url.endsWith('.node')
}

/**
 * Collect the modules reachable from `roots` along `edges`. The traversal
 * neither includes nor passes through a module for which `stop` holds.
 * Builtins are skipped.
 */
async function closure(
  roots: Iterable<string>,
  edges: (url: string) => Iterable<string> | Promise<Iterable<string>>,
  stop: (url: string) => boolean = () => false,
) {
  const result = new Set<string>()
  const traverse = async (url: string) => {
    if (result.has(url) || isBuiltin(url) || stop(url)) return
    result.add(url)
    await Promise.all([...await edges(url)].map(traverse))
  }
  await Promise.all([...roots].map(traverse))
  return result
}

/** A registered plugin whose module has changed. */
interface StalePlugin {
  /** the module to take the replacement from */
  url: string
  /** every module that exports the plugin */
  urls: string[]
  /** the plugin before the change */
  plugin: Plugin
  /** the closure of the plugin in the old module graph */
  modules: Set<string>
}

/** The import of a stale plugin in stage 1. */
interface ImportAttempt {
  stale: StalePlugin
  /** the new plugin, if the import succeeded */
  replacement?: Plugin
  failed: boolean
  error?: unknown
  /** the modules that were not cached before this import, other than evicted modules */
  loaded: string[]
}

/** A set of stale plugins that commit or abort together. */
interface ReconcileUnit {
  attempts: ImportAttempt[]
  /** the evicted modules in the closures of the plugins */
  modules: Set<string>
}

function toUrl(file: string | URL) {
  if (file instanceof URL) return file.href
  if (file.startsWith('file:')) return new URL(file).href
  return pathToFileURL(resolve(file)).href
}

/** Whether a module job failed to load, link or evaluate. */
function isBroken(job: ModuleJob) {
  const status = job.module?.getStatus()
  return status !== ModuleStatus.Instantiated
    && status !== ModuleStatus.Evaluating
    && status !== ModuleStatus.Evaluated
}

function toPath(url: string) {
  if (url.startsWith('file:')) return fileURLToPath(url)
}

class Hmr extends Service {
  /** The resolved `base`. `watch.root`, `watch.ignored` and logged paths are relative to it. */
  public baseDir: string

  /** Node's ESM loader. */
  public internal: ModuleLoader

  /**
   * The dependency tree of the main entry point. A change to any of these
   * modules can only be applied by restarting the process.
   */
  public hostModules = new Set<string>()

  /** The CJS module cache is read through it. */
  private _require = createRequire(import.meta.url)

  /** The tail of the transaction queue. */
  private _queue: Promise<void> = Promise.resolve()

  /** The running transaction, matched against the async context of a call. */
  private _current?: symbol
  private _storage = new AsyncLocalStorage<symbol>()

  constructor(ctx: Context, public config: Hmr.Config) {
    super(ctx, 'hmr')
    const internal = ModuleLoader.fromInternal()
    if (!internal) {
      throw new Error('loader internals are unavailable, pass --expose-internals or install node-addon-require-builtin')
    }
    this.internal = internal

    // On Windows, a drive-letter path is converted with `pathToFileURL`.
    // `new URL()` would read its `C:` as a URL scheme, which `fileURLToPath` rejects.
    // Without a `baseUrl`, file URLs are still decoded as URLs; ordinary
    // paths are resolved against the working directory.
    this.baseDir = process.platform === 'win32' && config.base && driveLetter.test(config.base)
      ? fileURLToPath(pathToFileURL(config.base))
      : ctx.baseUrl || config.base?.startsWith('file:')
        ? fileURLToPath(new URL(config.base || '.', ctx.baseUrl))
        : resolve(config.base || '.')

    ctx.inject(['fs'], ctx => this._watch(ctx))
  }

  /**
   * Reconcile the changes collected over each debounce window. A change to a
   * host module is only reported, since restarting is up to the host.
   */
  private _watch(ctx: Context) {
    const { enabled, root, ignored, debounce } = this.config.watch
    if (!enabled || !root.length) return
    if (!this.config.base) {
      this.ctx.logger.info('watching %o', root)
    } else {
      this.ctx.logger.info('watching %o in %s', root, this.baseDir)
    }

    const stashed = new Set<string>()
    const retained = new Set<string>()
    let timer: NodeJS.Timeout | undefined
    ctx.effect(() => () => clearTimeout(timer))

    // Batches are flushed one after another, including the handling of their
    // results, so that a batch takes the changes retained by the one before.
    let flushing = Promise.resolve()

    const flush = async () => {
      if (!stashed.size) return
      const files = new Set([...retained, ...[...stashed].map(toUrl)])
      retained.clear()
      stashed.clear()
      try {
        // This waits behind a running transaction.
        const result = await this.reconcile({ files })
        if (result.skippedHostModules.length) {
          this.ctx.logger.warn([
            'skipped host modules:',
            ...result.skippedHostModules.map(url => '- ' + this._relative(url)),
          ].join('\n'))
        }
        // an import failure has been logged by the transaction itself
        for (const { urls } of result.importFailures) {
          for (const url of urls) {
            if (files.has(url)) retained.add(url)
          }
        }
      } catch (error) {
        this.ctx.logger.warn(error)
        for (const url of files) retained.add(url)
      }
    }

    const match = picomatch(ignored)
    for (const path of root) {
      ctx.fs.watch(resolve(this.baseDir, path), (filename) => {
        this.ctx.logger.debug('change detected at %C', relative(this.baseDir, filename))
        stashed.add(filename)
        clearTimeout(timer)
        timer = setTimeout(() => flushing = flushing.then(flush), debounce)
      }, {
        // picomatch only splits on `/`, so a Windows path is converted before matching.
        ignored: filename => match(relative(this.baseDir, filename).split(sep).join('/')),
      })
    }
  }

  async* [Service.init]() {
    // Collect host modules: framework modules reachable from the main entry.
    // process.argv[1] is undefined in REPL, node -e, and some packed binaries.
    if (process.argv[1]) {
      const mainUrl = pathToFileURL(resolve(process.argv[1])).href
      if (this.internal.loadCache.has(mainUrl)) {
        this.hostModules = await closure([mainUrl], url => this._edges(url))
      }
    }
  }

  /**
   * The URLs of the modules linked by the jobs of `url`, in every type slot.
   * A job that failed to link contributes no URLs.
   */
  async getLinked(url: string) {
    const urls = new Set<string>()
    await Promise.all(getModuleJobs(this.internal.loadCache, url).map(async (job) => {
      let linked: ModuleJob[]
      try {
        linked = Array.from(await job.linked)
      } catch {
        return
      }
      for (const child of linked) urls.add(child.url)
    }))
    return [...urls]
  }

  /** The loaded modules: the keys of the ESM load cache and of the CJS module cache. */
  private _loaded() {
    const urls = new Set(Map.prototype.keys.call(this.internal.loadCache) as Iterable<string>)
    for (const path of Object.keys(this._require.cache)) urls.add(pathToFileURL(path).href)
    return urls
  }

  /**
   * The direct dependencies of a module in the current module caches: the
   * linked jobs of its ESM module job and the children of its CJS module.
   */
  private async _edges(url: string) {
    const edges = new Set(await this.getLinked(url))
    const path = toPath(url)
    for (const child of (path && this._require.cache[path]?.children) || []) {
      edges.add(pathToFileURL(child.filename).href)
    }
    return edges
  }

  /**
   * Remove the jobs of `url` that failed to load, link or evaluate, so that a
   * later import tries them again. The jobs in the other type slots are kept.
   */
  private _dropBroken(url: string) {
    const entry: Record<string, ModuleJob | undefined> | undefined = Map.prototype.get.call(this.internal.loadCache, url)
    if (!entry) return
    for (const type in entry) {
      if (entry[type] && isBroken(entry[type])) delete entry[type]
    }
    if (!Object.values(entry).some(Boolean)) this._evict(url)
  }

  /** Remove a module from both module caches. */
  private _evict(url: string) {
    Map.prototype.delete.call(this.internal.loadCache, url)
    const path = toPath(url)
    if (path) delete this._require.cache[path]
  }

  /**
   * Replace the plugins affected by `options.files`. Transactions run one at
   * a time; one started from within the running transaction is rejected.
   *
   * A changed module that no plugin depends on is still evicted from the
   * module cache: its next import, such as a dynamic one, gets the new code,
   * while existing references keep the old one.
   */
  reconcile(options: Hmr.ReconcileOptions): Promise<Hmr.Result> {
    const current = this._storage.getStore()
    if (current && current === this._current) {
      return Promise.reject(new Error('cannot start a transaction inside another transaction'))
    }
    const task = this._queue.then(() => {
      const id = Symbol('transaction')
      this._current = id
      return this._storage.run(id, () => this._reconcile(options)).finally(() => {
        this._current = undefined
      })
    })
    // only the order matters, so the result is not kept alive
    this._queue = task.then(() => {}, () => {})
    return task
  }

  private _relative(url: string) {
    // a module loaded through a custom scheme, such as `data:`, has no path
    if (!url.startsWith('file:')) return url
    return relative(this.baseDir, fileURLToPath(url))
  }

  /**
   * Classify the loaded modules into accepted (evicted from the module cache)
   * and declined (kept). The changed modules are accepted, and so is every
   * module that imports an accepted one. This does not depend on whether a
   * registered plugin uses them, so that a later import, such as by a plugin
   * that is enabled again, gets the new code. Host modules are declined.
   *
   * The returned `edges` are the dependencies of each loaded module before
   * the eviction, i.e. the old module graph.
   */
  private async _analyze(changed: Set<string>) {
    const urls = [...this._loaded()].filter(url => !isBuiltin(url))
    const edges = new Map<string, Set<string>>()
    await Promise.all(urls.map(async url => edges.set(url, await this._edges(url))))

    const importers = new Map<string, string[]>()
    for (const [url, children] of edges) {
      if (this.hostModules.has(url)) continue
      for (const child of children) {
        let list = importers.get(child)
        if (!list) importers.set(child, list = [])
        list.push(url)
      }
    }

    const accepted = new Set<string>()
    const queue = [...changed]
    while (queue.length) {
      const url = queue.pop()!
      if (accepted.has(url)) continue
      accepted.add(url)
      queue.push(...importers.get(url) ?? [])
    }

    const declined = new Set(this.hostModules)
    for (const url of urls) {
      if (!accepted.has(url)) declined.add(url)
    }
    return { accepted, declined, edges }
  }

  /**
   * Partition the attempts into units: the connected components of the
   * relation in which two plugins are related if their closures, in the old
   * or the new module graph, share an evicted module.
   *
   * @param edges the dependencies of a module in the new module graph
   * @param retained the modules kept in the caches through the eviction,
   * which import no evicted module, so that the traversal stops at them
   */
  private async _partition(
    attempts: ImportAttempt[],
    evicted: Set<string>,
    edges: (url: string) => Promise<Iterable<string>>,
    retained: Set<string>,
  ) {
    const reaches = await Promise.all(attempts.map(attempt => {
      return closure(attempt.stale.urls, edges, url => retained.has(url))
    }))
    const parents = attempts.map((_, index) => index)
    const find = (index: number) => {
      while (parents[index] !== index) index = parents[index] = parents[parents[index]]
      return index
    }
    const owners = new Map<string, number>()
    attempts.forEach((attempt, index) => {
      for (const url of [...attempt.stale.modules, ...reaches[index]]) {
        if (!evicted.has(url)) continue
        const owner = owners.get(url)
        if (owner === undefined) {
          owners.set(url, index)
        } else {
          parents[find(index)] = find(owner)
        }
      }
    })
    const units = new Map<number, ReconcileUnit>()
    attempts.forEach((attempt, index) => {
      const root = find(index)
      let unit = units.get(root)
      if (!unit) units.set(root, unit = { attempts: [], modules: new Set() })
      unit.attempts.push(attempt)
      for (const url of [...attempt.stale.modules, ...reaches[index]]) {
        if (evicted.has(url)) unit.modules.add(url)
      }
    })
    return [...units.values()]
  }

  /**
   * Find every loaded module that exports a registered plugin. When anything
   * in the dependency tree of such a module changes, the module is imported
   * again and the plugin is replaced.
   */
  private _discover(declined: Set<string>) {
    const internal = this.internal
    const candidates = new Map<ModuleJob, Plugin>()
    for (const url of Map.prototype.keys.call(internal.loadCache) as Iterable<string>) {
      if (declined.has(url) || isBuiltin(url)) continue
      const job = internal.loadCache.get(url)
      if (!job?.module) continue
      let plugin: Plugin | undefined
      try {
        // reading the bindings of a module whose evaluation failed throws
        plugin = unwrapExports(job.module.getNamespace())
      } catch {
        continue
      }
      if (!plugin || !this.ctx.registry.has(plugin)) continue
      candidates.set(job, plugin)
    }
    return candidates
  }

  private async _reconcile(options: Hmr.ReconcileOptions): Promise<Hmr.Result> {
    const result: Hmr.Result = { settledFibers: [], importFailures: [], skippedHostModules: [] }
    const files = new Set<string>()
    for (const url of [...options.files].map(toUrl)) {
      // A change to a host module or to a loaded native addon cannot be
      // applied in place. It is skipped, and restarting is up to the caller.
      if (this.hostModules.has(url) || isNativeAddon(url) && !!this._require.cache[toPath(url)!]) {
        result.skippedHostModules.push(url)
      } else {
        files.add(url)
      }
    }
    if (!files.size) return result

    const internal = this.internal

    // A module is loaded if it is in either module cache. In Node 24, a CJS
    // module imported via import() is in both of them.
    const loaded = this._loaded()
    const changed = new Set<string>()
    for (const url of files) {
      if (loaded.has(url)) {
        changed.add(url)
      } else {
        this.ctx.logger.debug('skip %C (not loaded)', this._relative(url))
      }
    }
    if (!changed.size) return result

    const { accepted, declined, edges } = await this._analyze(changed)
    const oldEdges = (url: string) => edges.get(url) ?? []

    // A plugin may be exported by several modules, e.g. an entry module that
    // re-exports its implementation. All of them are imported again together.
    const exporters = new Map<Plugin.Runtime, Map<ModuleJob, Plugin>>()
    for (const [job, plugin] of this._discover(declined)) {
      const runtime = this.ctx.registry.get(plugin)!
      let exported = exporters.get(runtime)
      if (!exported) exporters.set(runtime, exported = new Map())
      exported.set(job, plugin)
    }

    // The closure of a plugin consists of its modules and the accepted modules
    // they reach through accepted modules. It includes the modules of another
    // plugin, so that a plugin importing another one shares its unit.
    const stalePlugins: StalePlugin[] = []
    const evicted = new Set(accepted)
    const owned = new Set<string>()
    for (const exported of exporters.values()) {
      const jobs = [...exported.keys()]
      const own = new Set(jobs.map(job => job.url))
      const stop = (url: string) => declined.has(url) && !own.has(url)
      const closures = new Map<ModuleJob, Set<string>>()
      for (const job of jobs) {
        closures.set(job, await closure([job.url], oldEdges, stop))
      }
      const modules = new Set([...closures.values()].flatMap(closure => [...closure]))
      if (![...modules].some(url => accepted.has(url))) continue
      for (const url of modules) {
        evicted.add(url)
        owned.add(url)
      }

      // Use a module that no other module of the plugin imports.
      // Ambiguous aliases are deferred to the module/plugin identity work.
      const outermost = jobs.find(job => !jobs.some(other => other !== job && closures.get(other)!.has(job.url)))
      const job = outermost ?? jobs[0]
      stalePlugins.push({
        url: job.url,
        plugin: exported.get(job)!,
        urls: jobs.map(job => job.url),
        modules,
      })
    }

    for (const url of changed) {
      if (!owned.has(url)) this.ctx.logger.debug('evict %C (no dependent plugin)', this._relative(url))
    }

    /**
     * Clear module caches for the evicted modules before re-importing.
     *
     * We need to clear both:
     * 1. ESM loadCache — managed by Node's internal ModuleLoader
     * 2. CJS Module._cache — for CJS modules that were imported via import()
     *
     * A CJS module imported via import() is in both caches. If we only clear
     * loadCache, the CJS cache may serve stale modules.
     *
     * We use Map.prototype methods directly on loadCache. It is a `LoadCache`,
     * whose entries are `{ [type]: ModuleJob }`, one job per value of the
     * `type` import attribute. Its own delete(url) only sets the `javascript`
     * slot to undefined and keeps the entry, while Map.prototype.delete
     * removes the whole entry. `LoadCache` extends Node's internal `SafeMap`,
     * which carries the Map internal slots, so Map.prototype methods apply to
     * it although `loadCache instanceof Map` is false.
     */
    const esmBackup = new Map<string, unknown>()
    const cjsBackup = new Map<string, NodeJS.Module>()
    for (const url of evicted) {
      esmBackup.set(url, Map.prototype.get.call(internal.loadCache, url))
      const path = toPath(url)
      if (path && this._require.cache[path]) cjsBackup.set(path, this._require.cache[path])
      this._evict(url)
    }
    const restore = (url: string) => {
      this._evict(url)
      const job = esmBackup.get(url)
      if (job) Map.prototype.set.call(internal.loadCache, url, job)
      const path = toPath(url)
      if (path && cjsBackup.has(path)) this._require.cache[path] = cjsBackup.get(path)
    }

    // Stage 1: import the new modules of every stale plugin.
    // Plugin validity is checked here, where the only mutated state is the
    // module cache and no plugin has been touched yet. Moving this check
    // earlier is what allows the later stages to have no rollback at all: a malformed
    // export can no longer fail halfway through swapping instances.
    // No cache entry is restored before every plugin has been imported, so
    // that no new module links against an old module that has been evicted.
    const retained = this._loaded()
    const attempts: ImportAttempt[] = []
    for (const stale of stalePlugins) {
      const before = this._loaded()
      const attempt: ImportAttempt = { stale, loaded: [], failed: false }
      try {
        // Import the other modules of the plugin too, so that their failures
        // abort its unit as well.
        for (const url of stale.urls) {
          if (url !== stale.url) await internal.import(url, import.meta.url, {})
        }
        const exports = unwrapExports(await internal.import(stale.url, import.meta.url, {}))
        if (!this.ctx.registry.resolve(exports)) {
          throw new Error(`invalid plugin at ${this._relative(stale.url)}, `
            + `expect function or object with an "apply" method, received ${typeof exports}`)
        }
        attempt.replacement = exports
      } catch (error) {
        handleError(this.ctx, error)
        attempt.failed = true
        attempt.error = error
      }
      for (const url of this._loaded()) {
        if (!before.has(url) && !evicted.has(url)) attempt.loaded.push(url)
      }
      attempts.push(attempt)
    }

    // The new module graph is read once, before any cache entry is restored.
    const newGraph = new Map<string, Promise<Set<string>>>()
    const newEdges = (url: string) => {
      let edges = newGraph.get(url)
      if (!edges) newGraph.set(url, edges = this._edges(url))
      return edges
    }

    // A unit is a connected component of the stale plugins, where two plugins
    // are connected if their closures share an evicted module. The closure of a
    // plugin is taken in both the old module graph and the new one, so that
    // every evicted module that is imported again belongs to a single unit.
    const units = await this._partition(attempts, evicted, newEdges, retained)
    const aborted = units.filter(unit => unit.attempts.some(attempt => attempt.failed))
    const committed = units.filter(unit => !aborted.includes(unit))

    // An evicted module outside every unit is restored with the aborted units
    // it reaches in the old module graph, so that it links against the modules
    // they restore. If it also reaches a committed unit, neither version is
    // consistent with the caches, and it is left evicted.
    const unowned = new Set(evicted)
    for (const unit of units) unit.modules.forEach(url => unowned.delete(url))
    for (const url of unowned) {
      const reached = await closure([url], oldEdges, url => !evicted.has(url))
      const overlaps = (unit: ReconcileUnit) => [...unit.modules].some(url => reached.has(url))
      if (committed.some(overlaps)) continue
      for (const unit of aborted.filter(overlaps)) unit.modules.add(url)
    }

    // A module first loaded in stage 1 is removed from the caches if it reaches
    // a module to be restored in the new module graph, since it has been linked
    // against the new version. Otherwise, only its jobs that failed are removed,
    // each from its own type slot. Any other job is kept, including one loaded
    // by an aborted unit, so that a committed unit that imported it, statically
    // or dynamically, shares its instance with later imports.
    const restored = new Set(aborted.flatMap(unit => [...unit.modules]))
    for (const url of attempts.flatMap(attempt => attempt.loaded)) {
      const reached = await closure([url], newEdges, url => retained.has(url))
      if ([...reached].some(url => restored.has(url))) {
        this._evict(url)
      } else {
        this._dropBroken(url)
      }
    }
    for (const url of restored) restore(url)

    for (const unit of aborted) {
      const failure = unit.attempts.find(attempt => attempt.failed)!
      result.importFailures.push({ urls: [...unit.modules], error: failure.error })
    }

    // Stage 2: replace the plugins in place (synchronous).
    // A plugin may have been disposed while stage 1 was importing, in which
    // case the replacement only forwards a later registration of it.
    // Waiting is left to stage 3, so that no plugin is delayed behind another.
    const fibers: Fiber[] = []
    const applied = new Set(committed.flatMap(unit => unit.attempts))
    for (const attempt of attempts) {
      if (!applied.has(attempt)) continue
      const { url, plugin } = attempt.stale
      const path = this._relative(url)
      try {
        const replaced = this.ctx.registry.replace(plugin, attempt.replacement!)
        if (!replaced.length) continue
        this.ctx.logger.info('reload plugin at %C', path)
        fibers.push(...replaced)
      } catch (error) {
        this.ctx.logger.warn('failed to reload plugin at %C', path)
        this.ctx.logger.warn(error)
      }
    }

    // Stage 3: wait for the fibers to settle (concurrent).
    // No rollback: a plugin that fails to apply is left FAILED, exactly as it
    // would be on a cold start, and has already been logged by its fiber. It
    // keeps its parent and config, so the next change to the file retries it.
    await Promise.all(fibers.map(fiber => fiber.await().catch(() => {})))
    // a fiber below another restarted fiber may have been disposed by it
    result.settledFibers = fibers.filter(fiber => fiber.uid !== null)

    return result
  }
}

namespace Hmr {
  export interface WatchConfig {
    enabled: boolean
    root: string[]
    ignored: string[]
    debounce: number
  }

  export interface Config {
    base?: string
    watch: WatchConfig
  }

  export const Config: z<Config> = z.object({
    base: z.string().description('The base directory. Defaults to `ctx.baseUrl`.'),
    watch: z.object({
      enabled: z.boolean().default(false).description('Reload on file changes. Requires the `fs` service.'),
      root: z.array(String).role('table').default(['.']).description('Files or directories to watch, relative to `base`.'),
      ignored: z.array(String).role('table').default([
        '**/node_modules',
        '**/.*',
      ]).description('Files or directories not to watch, in glob patterns relative to `base`.'),
      debounce: z.natural().role('ms').default(100).description('Debounce changes before reloading, in milliseconds.'),
    }).description('Watch'),
  })

  export interface ReconcileOptions {
    /** absolute paths or `file:` URLs */
    files: Iterable<string | URL>
  }

  /** The running state is brought in line with the changes, as far as they can be applied. */
  export interface Result {
    settledFibers: Fiber[]
    importFailures: ImportFailure[]
    /**
     * The changed host modules and loaded native addons, which can only be
     * applied by restarting the process. They are skipped, while the other
     * changes are applied.
     */
    skippedHostModules: string[]
  }

  /**
   * A new module of a unit failed to import, or does not export a plugin.
   * Nothing in the unit is applied, and its module cache is restored. The
   * other units of the transaction are not affected.
   */
  export interface ImportFailure {
    /** the evicted modules of the unit, whose cache entries are restored */
    urls: string[]
    /** the first error raised while importing the unit */
    error: unknown
  }
}

export default Hmr
