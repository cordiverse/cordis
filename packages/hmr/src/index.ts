import { Context, Fiber, Plugin, Service } from 'cordis'
import { Dict } from 'cosmokit'
import { ModuleJob, ModuleLoader, unwrapExports } from '@cordisjs/plugin-loader'
import type Loader from '@cordisjs/plugin-loader'
import type {} from '@cordisjs/plugin-fs'
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

  interface Events {
    'hmr/reload'(result: Hmr.Result): void
  }
}

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

// A registered plugin whose module has changed.
interface StalePlugin {
  // the module to take the replacement from
  url: string
  // every module that exports the plugin
  urls: string[]
  // the plugin before the change
  plugin: Plugin
}

/** One instance of a stale plugin, paired with what will replace it. */
interface StaleFiber {
  /** the module file, relative to `baseDir`, for logging */
  path: string
  /** the freshly imported plugin to rebuild with */
  replacement: any
  /** the fiber left behind by the unload stage */
  fiber: Fiber
}

/**
 * Whether any ancestor of `fiber` is inactive, i.e. already disposed. Such a
 * fiber must not be rebuilt, for either of two reasons:
 *
 * - The ancestor is being reloaded in this batch, and rebuilding it rebuilds
 *   everything below it.
 * - The ancestor went away for an unrelated reason (a service disappeared, a
 *   concurrent config update). Nobody is going to rebuild it, and registering
 *   under a disposed context throws `INACTIVE_EFFECT`.
 */
function hasInactiveAncestor(fiber: Fiber) {
  for (let current = fiber.parent.fiber; ; current = current.parent.fiber) {
    if (current.uid === null) return true
    // the root fiber is its own parent's fiber
    if (current === current.parent.fiber) return false
  }
}

function toUrl(file: string | URL) {
  if (file instanceof URL) return file.href
  if (file.startsWith('file:')) return new URL(file).href
  return pathToFileURL(resolve(file)).href
}

class Hmr extends Service {
  // `root` and logged paths are relative to it
  public baseDir: string

  // `undefined` when Node's loader internals are unavailable, in which case
  // no module can be replaced
  public internal: ModuleLoader | undefined = ModuleLoader.fromInternal()

  // the dependency tree of the main entry point; a change to any of these
  // modules requires a restart
  public hosts = new Set<string>()

  // the tail of the transaction queue
  private _queue: Promise<unknown> = Promise.resolve()

  // the running transaction, matched against the async context of a call
  private _current?: symbol
  private _storage = new AsyncLocalStorage<symbol>()

  private _loader?: Loader

  constructor(ctx: Context, public config: Hmr.Config) {
    super(ctx, 'hmr')
    this.baseDir = ctx.baseUrl ? fileURLToPath(new URL('.', ctx.baseUrl)) : process.cwd()

    // Both services are optional. `reconcile()` depends on neither; they only
    // drive reloads from fs changes and the restarts those require.
    ctx.inject(['fs'], ctx => this._watch(ctx))
    ctx.inject(['loader'], (ctx) => {
      this._loader = ctx.loader
      ctx.effect(() => () => this._loader = undefined)
    })
  }

  // Changes are collected over the debounce window. A batch that can only be
  // applied by restarting the process calls `ctx.loader.exit()`.
  private _watch(ctx: Context) {
    const { enabled, root, ignored, debounce } = this.config.watch
    if (!enabled || !root.length) return
    this.ctx.logger.info('watching %o', root)

    const stashed = new Set<string>()
    let timer: NodeJS.Timeout | undefined
    ctx.effect(() => () => clearTimeout(timer))

    const flush = async () => {
      const files = [...stashed]
      stashed.clear()
      try {
        // This waits behind a running transaction.
        const result = await this.reconcile({ files })
        for (const { url, reason } of result.pending) {
          this.ctx.logger.debug('change at %C not applied (%s)', url, reason)
        }
        if (!result.restartReason) return
        if (!this._loader) {
          this.ctx.logger.warn('%s, restart required', result.restartReason)
          return
        }
        this.ctx.logger.info('%s, restarting', result.restartReason)
        await this._loader.exit()
      } catch (error) {
        this.ctx.logger.warn(error)
      }
    }

    const match = picomatch(ignored)
    for (const path of root) {
      ctx.fs.watch(resolve(this.baseDir, path), (filename) => {
        this.ctx.logger.debug('change detected at %C', relative(this.baseDir, filename))
        stashed.add(filename)
        clearTimeout(timer)
        timer = setTimeout(flush, debounce)
      }, {
        // picomatch only splits on `/`, so a Windows path is converted before matching.
        ignored: filename => match(relative(this.baseDir, filename).split(sep).join('/')),
      })
    }
  }

  async* [Service.init]() {
    if (!this.internal) {
      // eslint-disable-next-line max-len
      this.ctx.logger.warn('loader internals are unavailable, source code HMR is disabled; pass --expose-internals or install node-addon-require-builtin to enable it')
    }

    // Collect host modules: framework modules reachable from the main entry.
    // process.argv[1] is undefined in REPL, node -e, and some packed binaries.
    if (process.argv[1]) {
      const mainUrl = pathToFileURL(resolve(process.argv[1])).href
      const mainJob = this.internal?.loadCache.get(mainUrl)
      if (mainJob) {
        this.hosts = await loadDependencies(mainJob)
      }
    }
  }

  // hide stack trace from HMR
  getOuterStack = (): string[] => []

  async getLinked(url: string) {
    const job = this.internal?.loadCache.get(url)
    if (!job) return []
    const linked = await job.linked
    return Array.prototype.map.call(linked, (job: ModuleJob) => job.url) as string[]
  }

  // Transactions run one at a time: a call made while another transaction is
  // running waits for it to finish. A call made from within the running
  // transaction itself, such as from a plugin it applies, would wait for
  // itself and is rejected instead.
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
    this._queue = task.catch(() => {})
    return task
  }

  private _relative(url: string) {
    try {
      return relative(this.baseDir, fileURLToPath(url))
    } catch {
      return url
    }
  }

  // Classify the modules reachable from changed files into accepted (should
  // reload) and declined (should not). A file is accepted if it's directly
  // changed or if any of its dependencies are accepted. A file is declined if
  // none of its dependencies are accepted or if it's a host module.
  private async _analyze(changed: Set<string>) {
    const pending: string[] = []
    const accepted = new Set(changed)
    const declined = new Set(this.hosts)

    await Promise.all([...changed].map(async (url) => {
      const children = await this.getLinked(url)
      for (const child of children) {
        if (accepted.has(child) || declined.has(child) || isExcluded(child)) continue
        pending.push(child)
      }
    }))

    while (pending.length) {
      let index = 0, hasUpdate = false
      while (index < pending.length) {
        const url = pending[index]
        const children = await this.getLinked(url)
        let isDeclined = true, isAccepted = false
        for (const child of children) {
          if (declined.has(child) || isExcluded(child)) continue
          if (accepted.has(child)) {
            isAccepted = true
            break
          } else {
            isDeclined = false
            if (!pending.includes(child)) {
              hasUpdate = true
              pending.push(child)
            }
          }
        }
        if (isAccepted || isDeclined) {
          hasUpdate = true
          pending.splice(index, 1)
          if (isAccepted) {
            accepted.add(url)
          } else {
            declined.add(url)
          }
        } else {
          index++
        }
      }
      if (!hasUpdate) break
    }

    for (const url of pending) {
      declined.add(url)
    }

    return { accepted, declined }
  }

  // Find every loaded module that exports a registered plugin. The modules of
  // a plugin form an atomic reload unit: when anything in their dependency
  // trees changes, they are imported again and the plugin is replaced.
  private _discover(declined: Set<string>) {
    const internal = this.internal!
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
    const result: Hmr.Result = { replaced: [], failed: [], pending: [] }
    const files = new Set([...options.files].map(toUrl))
    if (!files.size) return result

    const internal = this.internal
    if (!internal) {
      for (const url of files) {
        result.pending.push({ url, reason: 'cache-unavailable' })
      }
      return result
    }

    // A change to a host module cannot be applied in place, and the restart
    // it requires supersedes everything else in the batch.
    const hosts = [...files].filter(url => this.hosts.has(url))
    if (hosts.length) {
      for (const url of files) {
        result.pending.push({ url, reason: this.hosts.has(url) ? 'host-module' : 'restart-required' })
      }
      result.restartReason = `host module changed: ${hosts.map(url => this._relative(url)).join(', ')}`
      return result
    }

    // In Node 24, both CJS and ESM modules imported via import() end up
    // in loadCache, so this check covers all module formats.
    const changed = new Set<string>()
    for (const url of files) {
      if (internal.loadCache.has(url)) {
        changed.add(url)
      } else {
        result.pending.push({ url, reason: 'not-loaded' })
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
      if (!owned.has(url)) result.pending.push({ url, reason: 'no-plugin' })
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

    const rollback = () => {
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
    // earlier is what allows stage 3 to have no rollback at all: a malformed
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
      result.aborted = { error }
      return result
    }

    // Stage 2: unload (per plugin, synchronous).
    // `registry.delete()` does not block, so deleting everything up front
    // costs nothing, and it is what makes the ancestor check below decidable:
    // by the time anything is rebuilt, every fiber this batch tears down has
    // already had its `uid` cleared.
    let staleFibers: StaleFiber[] = []
    for (const { url, plugin } of stalePlugins.values()) {
      // The plugin may have been disposed while stage 1 was importing.
      const runtime = this.ctx.registry.get(plugin)
      if (!runtime) continue
      const path = this._relative(url)

      // `registry.delete()` deliberately leaves the fibers in `runtime.fibers`
      // (the `registry.has()` guard in `Fiber` skips the removal) so that we
      // can rebuild from them; snapshot anyway, as the list is backed by a
      // live `Map` iterator.
      const fibers = [...runtime.fibers]
      try {
        this.ctx.registry.delete(plugin)
      } catch (err) {
        this.ctx.logger.warn('failed to dispose plugin at %C', path)
        this.ctx.logger.warn(err)
      }
      for (const fiber of fibers) {
        staleFibers.push({ path, replacement: replacements[url], fiber })
      }
    }

    // Everything below a fiber that is going away is rebuilt by that fiber, so
    // rebuilding it here as well would yield two instances. Decided in a
    // single pass now that every delete is done and before anything is
    // awaited, so that stage 3 only ever has to think about its own fiber.
    staleFibers = staleFibers.filter((stale) => {
      if (!hasInactiveAncestor(stale.fiber)) return true
      this.ctx.logger.debug('skip plugin at %C (inactive ancestor)', stale.path)
      return false
    })

    // Stage 3: reload (per fiber, concurrent).
    const logged = new Set<string>()
    await Promise.all(staleFibers.map(async ({ path, replacement, fiber }) => {
      let newFiber: Fiber | undefined
      try {
        while (fiber.inertia) await fiber.inertia

        const entry = fiber.entry
        // Re-enable's init() may still be awaiting. It does not wait on stage 3.
        // A rejection is already logged and must not skip the decision below.
        while (entry?._initTask) await entry._initTask.catch(() => {})

        // The host may have been replaced during the wait (e.g. disabled and re-enabled).
        if (hasInactiveAncestor(fiber)) {
          this.ctx.logger.debug('skip plugin at %C (inactive ancestor)', path)
          return
        }

        const removed = !!entry && entry.parent.tree.store[entry.options.id] !== entry
        // A nested fiber shares the host entry. Only the entry root can already be live.
        const isEntryRoot = !!entry && fiber.parent.fiber?.entry !== entry
        // `fiber` itself is disposed, so a live `entry.innerFiber` is a replacement.
        const replaced = isEntryRoot && entry.innerFiber?.uid != null
        if (entry?.disabled || removed || replaced) {
          const reason = entry?.disabled ? 'disabled' : removed ? 'removed' : 'live fiber'
          this.ctx.logger.debug(`skip plugin at %C (${reason})`, path)
          return
        }

        newFiber = fiber.parent.registry.plugin(replacement, fiber.config, this.getOuterStack)
        newFiber.entry = fiber.entry
        if (isEntryRoot) entry.innerFiber = newFiber
        if (!logged.has(path)) {
          logged.add(path)
          this.ctx.logger.info('reload plugin at %C', path)
        }
        await newFiber.await()
        result.replaced.push(newFiber)
      } catch (error) {
        // No rollback: a plugin that fails to load is left failed, exactly
        // as it would be on a cold start. It stays registered and keeps its
        // parent and config, so the next change to the file retries it.
        // A failure inside the new fiber has already been logged by itself.
        if (!newFiber) {
          this.ctx.logger.warn('failed to reload plugin at %C', path)
          this.ctx.logger.warn(error)
        }
        result.failed.push({ fiber: newFiber ?? fiber, error })
      }
    }))

    this.ctx.emit('hmr/reload', result)
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
    watch: WatchConfig
  }

  export const Config: z<Config> = z.object({
    watch: z.object({
      enabled: z.boolean().default(false).description('Reload on file changes. Requires the `fs` service.'),
      root: z.array(String).role('table').default(['.']).description('Files or directories to watch, relative to the context.'),
      ignored: z.array(String).role('table').default([
        '**/node_modules',
        '**/.*',
        'cache',
        'data',
      ]).description('Files or directories not to watch, in glob patterns.'),
      debounce: z.natural().role('ms').default(100).description('Debounce changes before reloading, in milliseconds.'),
    }).description('Watch'),
  })

  export interface ReconcileOptions {
    // absolute paths or `file:` URLs
    files: Iterable<string | URL>
  }

  export type PendingReason =
    // the module cache is not accessible, so no module can be replaced
    | 'cache-unavailable'
    // the file is a host module, which requires a restart
    | 'host-module'
    // another file in the batch is a host module, so nothing is applied
    | 'restart-required'
    // no module has been loaded from the file
    | 'not-loaded'
    // the module is loaded, but no registered plugin depends on it
    | 'no-plugin'

  export interface Pending {
    url: string
    reason: PendingReason
  }

  export interface Failure {
    // left FAILED, as on a cold start
    fiber: Fiber
    error: unknown
  }

  export interface Result {
    replaced: Fiber[]
    failed: Failure[]
    // set when the new modules failed to import; nothing has been replaced
    aborted?: { error: unknown }
    // changed files that have not been applied
    pending: Pending[]
    // set when the batch can only be applied by restarting the process
    restartReason?: string
  }
}

export default Hmr
