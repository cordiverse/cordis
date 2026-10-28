import { Context, Fiber, Plugin, Service } from 'cordis'
import { Dict } from 'cosmokit'
import { ModuleJob, ModuleLoader, unwrapExports } from '@cordisjs/loader-utils'
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

function isExcluded(url: string) {
  return url.startsWith('node:') || url.includes('/node_modules/')
}

/**
 * Recursively collect all module dependencies from a ModuleJob.
 * Skips node: builtins and node_modules to focus on user code.
 */
async function loadDependencies(job: ModuleJob, ignored = new Set<string>()) {
  const dependencies = new Set<string>()
  async function traverse(job: ModuleJob) {
    if (ignored.has(job.url) || dependencies.has(job.url)) return
    if (isExcluded(job.url)) return
    dependencies.add(job.url)
    const children = await job.linked
    await Promise.all(Array.prototype.map.call(children, traverse))
  }
  await traverse(job)
  return dependencies
}

/** A registered plugin whose module has changed. */
interface StalePlugin {
  /** the module to take the replacement from */
  url: string
  /** every module that exports the plugin */
  urls: string[]
  /** the plugin before the change */
  plugin: Plugin
}

function toUrl(file: string | URL) {
  if (file instanceof URL) return file.href
  if (file.startsWith('file:')) return new URL(file).href
  return pathToFileURL(resolve(file)).href
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
      const mainJob = this.internal.loadCache.get(mainUrl)
      if (mainJob) {
        this.hostModules = await loadDependencies(mainJob)
      }
    }
  }

  async getLinked(url: string) {
    const job = this.internal.loadCache.get(url)
    if (!job) return []
    const linked = await job.linked
    return Array.prototype.map.call(linked, (job: ModuleJob) => job.url) as string[]
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
   */
  private async _analyze(changed: Set<string>) {
    const urls = [...Map.prototype.keys.call(this.internal.loadCache) as Iterable<string>]
    const importers = new Map<string, string[]>()
    await Promise.all(urls.map(async (url) => {
      if (isExcluded(url) || this.hostModules.has(url)) return
      let children: string[]
      try {
        children = await this.getLinked(url)
      } catch {
        // a module that failed to link has no dependencies to follow
        return
      }
      for (const child of children) {
        let list = importers.get(child)
        if (!list) importers.set(child, list = [])
        list.push(url)
      }
    }))

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
    return { accepted, declined }
  }

  /**
   * Find every loaded module that exports a registered plugin. The modules of
   * a plugin form an atomic reload unit: when anything in their dependency
   * trees changes, they are imported again and the plugin is replaced.
   */
  private _discover(declined: Set<string>) {
    const internal = this.internal
    const candidates = new Map<ModuleJob, Plugin>()
    for (const url of Map.prototype.keys.call(internal.loadCache) as Iterable<string>) {
      if (declined.has(url) || isExcluded(url)) continue
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
      // A change to a host module cannot be applied in place. It is skipped,
      // and restarting is up to the caller.
      if (this.hostModules.has(url)) {
        result.skippedHostModules.push(url)
      } else {
        files.add(url)
      }
    }
    if (!files.size) return result

    const internal = this.internal

    // In Node 24, both CJS and ESM modules imported via import() end up
    // in loadCache, so this check covers all module formats.
    const changed = new Set<string>()
    for (const url of files) {
      if (internal.loadCache.has(url)) {
        changed.add(url)
      } else {
        this.ctx.logger.debug('skip %C (not loaded)', this._relative(url))
      }
    }
    if (!changed.size) return result

    const { accepted, declined } = await this._analyze(changed)
    const invalidatedModules = new Set(accepted)
    const stalePlugins = new Map<Plugin.Runtime, StalePlugin>()
    const owned = new Set<string>()

    // A plugin may be exported by several modules, e.g. an entry module that
    // re-exports its implementation. All of them form a single reload unit.
    const units = new Map<Plugin.Runtime, Map<ModuleJob, Plugin>>()
    for (const [job, plugin] of this._discover(declined)) {
      const runtime = this.ctx.registry.get(plugin)!
      let unit = units.get(runtime)
      if (!unit) units.set(runtime, unit = new Map())
      unit.set(job, plugin)
    }

    // Plugin modules are atomic reload units, so the dependency tree of one
    // stops at every module of another unit.
    for (const unit of units.values()) {
      for (const job of unit.keys()) declined.add(job.url)
    }

    // Check each unit's dependency tree for accepted files
    for (const [runtime, unit] of units) {
      for (const job of unit.keys()) declined.delete(job.url)
      const closures = new Map<ModuleJob, Set<string>>()
      for (const job of unit.keys()) {
        closures.set(job, await loadDependencies(job, declined))
      }
      for (const job of unit.keys()) declined.add(job.url)

      const dependencies = new Set([...closures.values()].flatMap(closure => [...closure]))
      if (![...dependencies].some(dep => accepted.has(dep))) continue
      dependencies.forEach((dep) => {
        invalidatedModules.add(dep)
        owned.add(dep)
      })

      // Use a module that no other module of the unit imports.
      // Ambiguous aliases are deferred to the module/plugin identity work.
      const jobs = [...unit.keys()]
      const outermost = jobs.find(job => !jobs.some(other => other !== job && closures.get(other)!.has(job.url)))
      const job = outermost ?? jobs[0]
      stalePlugins.set(runtime, {
        url: job.url,
        plugin: unit.get(job)!,
        urls: jobs.map(job => job.url),
      })
    }

    for (const url of changed) {
      if (!owned.has(url)) this.ctx.logger.debug('evict %C (no dependent plugin)', this._relative(url))
    }

    /**
     * Clear module caches for affected modules and complete dependency trees
     * of selected plugins before re-importing.
     *
     * We need to clear both:
     * 1. ESM loadCache — managed by Node's internal ModuleLoader
     * 2. CJS Module._cache — for CJS modules that were imported via import()
     *
     * In Node 24, CJS modules loaded via import() appear in both caches.
     * If we only clear loadCache, the CJS cache may serve stale modules.
     *
     * We use Map.prototype methods directly on loadCache because:
     * - In Node 22/23, loadCache is a plain Map<url, ModuleJob>
     * - In Node 24, loadCache is a LoadCache extends Map<url, { [type]: ModuleJob }>
     *   where .delete() only sets the type slot to undefined (doesn't remove the entry)
     * Using Map.prototype.delete ensures complete removal in both versions.
     */
    const esmBackup: Dict = Object.create(null)
    const cjsBackup: Dict = Object.create(null)
    const require = createRequire(import.meta.url)
    for (const filename of invalidatedModules) {
      // Backup and clear ESM loadCache
      const job = Map.prototype.get.call(internal.loadCache, filename)
      esmBackup[filename] = job
      Map.prototype.delete.call(internal.loadCache, filename)

      // Backup and clear CJS Module._cache
      try {
        const filepath = fileURLToPath(filename)
        if (require.cache[filepath]) {
          cjsBackup[filepath] = require.cache[filepath]
          delete require.cache[filepath]
        }
      } catch {
        // filename might not be a file: URL (e.g. node: protocol), ignore
      }
    }

    const esmKeys = new Set(Map.prototype.keys.call(internal.loadCache) as Iterable<string>)
    const cjsKeys = new Set(Object.keys(require.cache))
    const rollback = () => {
      for (const filename of [...Map.prototype.keys.call(internal.loadCache) as Iterable<string>]) {
        if (!esmKeys.has(filename)) Map.prototype.delete.call(internal.loadCache, filename)
      }
      for (const filepath of Object.keys(require.cache)) {
        if (!cjsKeys.has(filepath)) delete require.cache[filepath]
      }
      for (const filename in esmBackup) {
        Map.prototype.set.call(internal.loadCache, filename, esmBackup[filename])
      }
      for (const filepath in cjsBackup) {
        require.cache[filepath] = cjsBackup[filepath]
      }
    }

    // Stage 1: re-import the module graph (all-or-nothing).
    // Plugin validity is checked here, where the only mutated state is the
    // module cache and no plugin has been touched yet. Moving this check
    // earlier is what allows the later stages to have no rollback at all: a malformed
    // export can no longer fail halfway through swapping instances.
    const replacements: Dict = Object.create(null)
    try {
      for (const { url, urls } of stalePlugins.values()) {
        // Import the other modules of the unit too, so that their failures
        // abort the batch as well.
        for (const other of urls) {
          if (other !== url) await internal.import(other, import.meta.url, {})
        }
        const exports = unwrapExports(await internal.import(url, import.meta.url, {}))
        if (!this.ctx.registry.resolve(exports)) {
          throw new Error(`invalid plugin at ${this._relative(url)}, `
            + `expect function or object with an "apply" method, received ${typeof exports}`)
        }
        replacements[url] = exports
      }
    } catch (error) {
      handleError(this.ctx, error)
      rollback()
      // the whole batch is a single unit for now
      result.importFailures.push({ urls: [...invalidatedModules], error })
      return result
    }

    // Stage 2: replace the plugins in place (synchronous).
    // A plugin may have been disposed while stage 1 was importing, in which
    // case the replacement only forwards a later registration of it.
    // Waiting is left to stage 3, so that no plugin is delayed behind another.
    const fibers: Fiber[] = []
    for (const { url, plugin } of stalePlugins.values()) {
      const path = this._relative(url)
      try {
        const replaced = this.ctx.registry.replace(plugin, replacements[url])
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
     * The changed host modules, which can only be applied by restarting the
     * process. They are skipped, while the other changes are applied.
     */
    skippedHostModules: string[]
  }

  /**
   * A new module of a unit failed to import, or does not export a plugin.
   * Nothing in the unit is applied, and its module cache is restored.
   */
  export interface ImportFailure {
    /** the modules of the unit */
    urls: string[]
    error: unknown
  }
}

export default Hmr
