import { Context, Fiber, Plugin, Service } from 'cordis'
import { Dict } from 'cosmokit'
import { ModuleJob, ModuleLoader, unwrapExports } from '@cordisjs/plugin-loader'
import type Loader from '@cordisjs/plugin-loader'
import type {} from '@cordisjs/plugin-fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { relative, resolve, sep } from 'node:path'
import { handleError } from './error.ts'
import { collectDependencies, isBuiltin, isPackaged } from './graph.ts'
import { IdentityStore } from './identity.ts'
import { cjsChildren, cjsHas, cjsUrls, ModuleCache } from './cache.ts'
import { invalidate } from './manifest.ts'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

// A Windows drive-letter path, e.g. `C:\app\cordis.yml` or `C:/app/cordis.yml`.
const driveLetter = /^[A-Za-z]:[\\/]/

// A registered plugin whose module has changed.
interface StalePlugin {
  // the module to take the replacement from
  url: string
  // every module that exports the plugin
  urls: string[]
  // the plugin before the change
  plugin: Plugin
}

/**
 * How deep the fibers of a stale plugin sit, so that a host is replaced before
 * the entries it rebuilds. A plugin without a runtime sorts last; it is skipped.
 */
function fiberDepth(runtime?: Plugin.Runtime) {
  let depth = Infinity
  for (const fiber of runtime?.fibers ?? []) {
    let current = fiber
    let level = 0
    while (current.parent.fiber !== current) {
      current = current.parent.fiber
      level++
    }
    depth = Math.min(depth, level)
  }
  return depth
}

function toUrl(file: string | URL) {
  if (file instanceof URL) return file.href
  if (file.startsWith('file:')) return new URL(file).href
  return pathToFileURL(resolve(file)).href
}

class Hmr extends Service {
  // `watch.root` and logged paths are relative to it
  public baseDir: string

  // `undefined` when Node's loader internals are unavailable, in which case
  // no module can be replaced
  public internal: ModuleLoader | undefined = ModuleLoader.fromInternal()

  // the dependency tree of the main entry point; a change to any of these
  // modules requires a restart
  public hosts = new Set<string>()

  // set when the host graph could not be computed, which keeps package
  // modules out of the dependency walk
  private _hostsUnknown = false

  // the recorded identity of every module file a transaction has touched:
  // the disk is compared against it, so a caller does not need to know which
  // files an operation changed
  public identity = new IdentityStore()

  // the tail of the transaction queue
  private _queue: Promise<unknown> = Promise.resolve()

  // the running transaction, matched against the async context of a call
  private _current?: symbol
  private _storage = new AsyncLocalStorage<symbol>()

  private _loader?: Loader

  constructor(ctx: Context, public config: Hmr.Config) {
    super(ctx, 'hmr')
    // On Windows, a drive-letter path is converted with `pathToFileURL`.
    // `new URL()` would read its `C:` as a URL scheme, which `fileURLToPath` rejects.
    // Without a `baseUrl`, file URLs are still decoded as URLs; ordinary
    // paths are resolved against the working directory.
    this.baseDir = process.platform === 'win32' && config.base && driveLetter.test(config.base)
      ? fileURLToPath(pathToFileURL(config.base))
      : ctx.baseUrl || config.base?.startsWith('file:')
        ? fileURLToPath(new URL(config.base || '.', ctx.baseUrl))
        : resolve(config.base || '.')

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
    if (!this.config.base) {
      this.ctx.logger.info('watching %o', root)
    } else {
      this.ctx.logger.info('watching %o in %s', root, this.baseDir)
    }

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
        this.hosts = this.widen(await collectDependencies(mainJob), new Set())
      }
    }
    if (!this.hosts.size) {
      // The host graph is what keeps framework modules out of a reload;
      // without it, package modules stay excluded, as before the traversal
      // learned to cross them.
      this.ctx.logger.warn('host modules are unknown, node_modules stays excluded')
      this._hostsUnknown = true
    }

    // Record the identity of everything loaded so far, so the first
    // `reconcile({ roots })` compares against a baseline; modules loaded
    // later are covered at the end of the first transaction that touches them.
    if (this.internal) {
      this.identity.observeAll(Map.prototype.keys.call(this.internal.loadCache) as Iterable<string>)
    }
  }

  // hide stack trace from HMR
  getOuterStack = (): string[] => []

  // Widen a dependency closure with the dependencies the ESM walk cannot see:
  // a CJS module resolves its `require` calls at evaluation time, so they are
  // recorded in `children` rather than `linked`, and a module that was only
  // ever required never enters `loadCache` at all.
  private widen(closure: Set<string>, stop: Set<string>) {
    const result = new Set(closure)
    const queue = [...result]
    while (queue.length) {
      const url = queue.pop()!
      for (const child of cjsChildren(url)) {
        if (result.has(child) || stop.has(child) || isBuiltin(child) || (this._hostsUnknown && isPackaged(child))) continue
        result.add(child)
        queue.push(child)
      }
    }
    return result
  }

  async getLinked(url: string) {
    const job = this.internal?.loadCache.get(url)
    const linked = job ? await job.linked : []
    // a CJS module resolves its dependencies through `require`, which the ESM
    // linker does not record: `children` are the edges `linked` misses
    return [
      ...Array.prototype.map.call(linked, (job: ModuleJob) => job.url) as string[],
      ...cjsChildren(url),
    ]
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
        if (accepted.has(child) || declined.has(child) || isBuiltin(child) || (this._hostsUnknown && isPackaged(child))) continue
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
          if (declined.has(child) || isBuiltin(child) || (this._hostsUnknown && isPackaged(child))) continue
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
    const result: Hmr.Result = { replaced: [], failed: [], pending: [] }
    const files = new Set([...options.files ?? []].map(toUrl))

    const internal = this.internal
    if (!internal) {
      for (const url of files) {
        result.pending.push({ url, reason: 'cache-unavailable' })
      }
      return result
    }

    // `roots` widens the batch to what a package operation may have rewritten.
    // Only recorded or loaded files can matter: an entry counts as loaded when
    // any of its slots holds a job (the keys also name entries `has` cannot
    // serve, such as JSON modules), and the CJS cache holds the modules that
    // were only ever required.
    if (options.roots) {
      const loaded = [
        ...[...Map.prototype.keys.call(internal.loadCache) as Iterable<string>]
          .filter(url => {
            const entry = Map.prototype.get.call(internal.loadCache, url) as Record<string, unknown>
            return entry && Object.values(entry).some(Boolean)
          }),
        ...cjsUrls(),
      ]
      for (const root of options.roots) {
        // a package operation rewrites whole subtrees; an updated package
        // stops resolving its entries through Node's cached manifest reader
        invalidate(toUrl(root))
        for (const url of this.identity.expand(toUrl(root), loaded)) {
          files.add(url)
        }
      }
    }
    if (!files.size) return result

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
    // in loadCache, so this check covers all module formats; a module that
    // was only ever required lives in the CJS cache alone.
    const changed = new Set<string>()
    for (const url of files) {
      if (internal.loadCache.has(url) || cjsHas(url)) {
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
        closures.set(job, this.widen(await collectDependencies(job, declined, this._hostsUnknown), declined))
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

    // the cache keys present before the transaction, to tell what it imported
    const before = new Set(Map.prototype.keys.call(internal.loadCache) as Iterable<string>)
    const beforeCjs = new Set(cjsUrls())
    try {
      const cache = new ModuleCache(internal)
      cache.evict(invalidatedModules)

      const rollback = () => cache.restore()

      // Stage 1: re-import the module graph (all-or-nothing).
      // Plugin validity is checked here, where the only mutated state is the
      // module cache and no plugin has been touched yet. Moving this check
      // earlier is what allows stage 2 to have no rollback of its own: a
      // malformed export can no longer fail halfway through swapping instances.
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

      // Stage 2: reload in place.
      // Each stale plugin's fibers move to the runtime of its replacement and
      // restart there, so `entry.innerFiber`, the value returned by `ctx.plugin()`
      // and any other fiber reference stay valid, and no entry bookkeeping is
      // needed. A fiber that is waiting for its dependencies only takes the new
      // runtime and loads from it when they arrive.
      //
      // Hosts go first: a host that is stale as well rebuilds its subtree from
      // the freshly imported modules, which leaves the fibers of its stale
      // children disposed. Replacing a child first would apply it once there and
      // once more under the rebuilt host, so the batch runs level by level.
      const levels = new Map<number, { plugin: Plugin; url: string; runtime: Plugin.Runtime }[]>()
      for (const [runtime, { url, plugin }] of stalePlugins) {
        const depth = fiberDepth(runtime)
        let level = levels.get(depth)
        if (!level) levels.set(depth, level = [])
        level.push({ plugin, url, runtime })
      }

      const logged = new Set<string>()
      for (const depth of [...levels.keys()].sort((a, b) => a - b)) {
        // one level at a time: siblings are unrelated to each other, so they run
        // together, while a host is always replaced before what it rebuilds
        await Promise.all(levels.get(depth)!.map(async ({ plugin, url, runtime }) => {
          const path = this._relative(url)
          try {
            await this.ctx.registry.replace(plugin, replacements[url])
            if (!logged.has(path)) {
              logged.add(path)
              this.ctx.logger.info('reload plugin at %C', path)
            }
          } catch (err) {
            // No rollback: a plugin that fails to load is left failed, exactly
            // as it would be on a cold start. It stays registered and keeps its
            // parent and config, so the next change to the file retries it.
            this.ctx.logger.warn('failed to reload plugin at %C', path)
            this.ctx.logger.warn(err)
          }
        }))
      }

      this.ctx.emit('hmr/reload', result)
      return result
    } finally {
      // Record the identity of every module the transaction touched, whether
      // it succeeded or aborted: the disk holds the new content either way,
      // and recording now keeps the next transaction from judging the same
      // file changed again. A later fix still bumps mtime and is caught.
      const touched = new Set(invalidatedModules)
      for (const url of Map.prototype.keys.call(internal.loadCache) as Iterable<string>) {
        if (!before.has(url)) touched.add(url)
      }
      for (const url of cjsUrls()) {
        if (!beforeCjs.has(url)) touched.add(url)
      }
      this.identity.observeAll(touched)
    }
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
    base: z.string().description('The directory that logged paths and `watch.root` are relative to, defaults to the context directory.'),
    watch: z.object({
      enabled: z.boolean().default(false).description('Reload on file changes. Requires the `fs` service.'),
      root: z.array(String).role('table').default(['.']).description('Files or directories to watch, relative to `base`.'),
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
    files?: Iterable<string | URL>
    // absolute paths or `file:` URLs of directories or files whose whole
    // subtree may have been rewritten, e.g. by a package manager: every
    // recorded or loaded module underneath whose content cannot be proven
    // unchanged joins the batch. At least one of the two is required; when
    // both are given the batches are unioned.
    roots?: Iterable<string | URL>
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
