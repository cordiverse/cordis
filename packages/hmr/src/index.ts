import { Context, Fiber, Plugin, Service } from 'cordis'
import type {} from '@cordisjs/plugin-fs-node'
import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { handleError } from './error.ts'
import {
  activate, invalidateResolution, locatePackage, ModuleCaches, ModuleLoader, Resolution, resolveRequest, restoreResolutions,
} from './runtime/index.ts'
import { fileURLToPath, pathToFileURL } from 'node:url'
import z from 'schemastery'

declare module 'cordis' {
  interface Context {
    hmr: Hmr
  }
}

type Awaitable<T> = T | Promise<T>

// A specifier that is a URL, e.g. `file:` or `data:`.
const scheme = /^[a-z][a-z\d+.-]*:/i

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
  /** the modules of `urls` that no other module of `urls` imports, including `url` */
  entries: string[]
  /** the plugin before the change */
  plugin: Plugin
  /** the closure of the plugin in the old module graph */
  modules: Set<string>
}

/** A change found in stage 1 that cannot be applied in place, reported in `skipped`. */
class SkipError extends Error {
  constructor(public reason: Hmr.SkipReason) {
    super(reason)
  }
}

/**
 * Whether a resolution records a request that may resolve elsewhere later,
 * unlike a URL or an absolute path, which resolves to itself.
 */
function isRequest({ specifier }: Resolution) {
  return !isAbsolute(specifier) && !scheme.test(specifier)
}

/** Whether `path` is `dir` or lies below it. */
function contains(dir: string, path: string) {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

/**
 * Whether the changes at `root` concern the module at `path`: the module lies
 * below it, or below the directory to which `root` adds a package as
 * `node_modules/<name>`, where its imports of the package may resolve to it.
 * A manifest stands for its directory.
 */
function covers(root: string, path: string) {
  if (basename(root) === 'package.json') root = dirname(root)
  if (contains(root, path)) return true
  const location = locatePackage(root)
  return !!location && contains(location.dir, path)
}

/** The import of a stale plugin in stage 1. */
interface ImportAttempt {
  stale: StalePlugin
  /** the modules imported for the entries of the plugin, which may have moved */
  imported: string[]
  /** the new plugin, if the import succeeded */
  replacement?: Plugin
  failed: boolean
  error?: unknown
  /** why the plugin cannot be replaced in place, if it cannot */
  skip?: Hmr.SkipReason
  /** the modules that were not cached before this import, other than evicted modules */
  loaded: string[]
}

/** A set of stale plugins that commit, abort or are skipped together. */
interface ReconcileUnit {
  attempts: ImportAttempt[]
  /** the evicted modules in the closures of the plugins */
  modules: Set<string>
}

/** Get the plugin exported by a module namespace. */
function unwrapExports(exports: any) {
  if (exports === null || exports === undefined) return exports
  exports = exports.default ?? exports
  // https://github.com/evanw/esbuild/issues/2623
  // https://esbuild.github.io/content-types/#default-interop
  if (!exports.__esModule) return exports
  return exports.default ?? exports
}

function toPath(url: string) {
  if (url.startsWith('file:')) return fileURLToPath(url)
}

class Hmr extends Service {
  /** The resolved `base`. `watch.files` and logged paths are relative to it. */
  public baseDir: string

  /** Node's internal ESM loader. */
  private _loader: ModuleLoader
  /** Node's module caches. */
  private _modules: ModuleCaches

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
    const loader = ModuleLoader.fromInternal()
    if (!loader) {
      throw new Error('loader internals are unavailable, pass --expose-internals or install node-addon-require-builtin')
    }
    this._loader = loader
    this._modules = new ModuleCaches(loader)
    ctx.effect(() => activate())

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
    const { enabled, files, debounce } = this.config.watch
    if (!enabled || !files.length) return
    if (!this.config.base) {
      this.ctx.logger.info('watching %o', files)
    } else {
      this.ctx.logger.info('watching %o in %s', files, this.baseDir)
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
      const files = new Set([...retained, ...stashed])
      retained.clear()
      stashed.clear()
      try {
        // This waits behind a running transaction.
        const result = await this.reconcile(() => files)
        if (result.skipped.length) {
          this.ctx.logger.warn([
            'skipped changes, which apply after a restart:',
            ...result.skipped.flatMap(({ urls, reason }) => urls.map(url => `- ${this._relative(url)} (${reason})`)),
          ].join('\n'))
        }
        // An aborted unit has been logged by the transaction itself. Its
        // changes are retried with the next batch, which may only repair a
        // module that the unit newly imports.
        const paths = result.aborted.flatMap(({ urls }) => urls.flatMap(url => toPath(url) ?? []))
        for (const file of files) {
          if (paths.some(path => covers(file, path))) retained.add(file)
        }
      } catch (error) {
        this.ctx.logger.warn(error)
        for (const path of files) retained.add(path)
      }
    }

    ctx.fs.watch(this.baseDir, { filter: files }).on('change', (filename) => {
      this.ctx.logger.debug('change detected at %C', relative(this.baseDir, filename))
      stashed.add(filename)
      clearTimeout(timer)
      timer = setTimeout(() => flushing = flushing.then(flush), debounce)
    })
  }

  async* [Service.init]() {
    // Collect host modules: framework modules reachable from the main entry.
    // process.argv[1] is undefined in REPL, node -e, and some packed binaries.
    if (process.argv[1]) {
      const mainUrl = pathToFileURL(resolve(process.argv[1])).href
      if (this._modules.has(mainUrl)) {
        this.hostModules = await closure([mainUrl], url => this._modules.edges(url))
      }
    }
  }

  /**
   * Run `callback` as the body of a transaction, and replace the plugins
   * affected by the roots that it resolves to. Transactions run one at a
   * time; one started from within the running transaction, including from
   * `callback`, is rejected. If `callback` throws, the transaction rejects
   * with its error and the module caches are left as they are.
   *
   * A root is an absolute path of a file or a directory. The loaded modules
   * whose files are the root or lie below it are changed. Module URLs are
   * real paths, so a root is matched against them as it is: the caller passes
   * the real path under which modules were loaded, such as the previous
   * target of a link. For a package, the caller also passes its location,
   * such as the link itself or a directory where a package is added, since
   * Node resolves package names through it.
   *
   * Later resolutions observe the file system below the roots. A plugin
   * whose module is no longer where the import that loaded it now resolves,
   * e.g. after its package exports another entry or a link is retargeted, is
   * replaced from the module that the import resolves to.
   *
   * A changed module that no plugin depends on is still evicted from the
   * module cache: its next import, such as a dynamic one, gets the new code,
   * while existing references keep the old one.
   *
   * Every transaction first removes the module jobs that failed to load, link
   * or evaluate, whether or not their files changed, so that the next import
   * of their modules tries again.
   */
  reconcile(callback: () => Awaitable<Iterable<string>>): Promise<Hmr.Result> {
    const current = this._storage.getStore()
    if (current && current === this._current) {
      return Promise.reject(new Error('cannot start a transaction inside another transaction'))
    }
    const task = this._queue.then(() => {
      const id = Symbol('transaction')
      this._current = id
      return this._storage.run(id, () => this._reconcile(callback)).finally(() => {
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
    const caches = this._modules
    const urls = [...caches.urls()].filter(url => !isBuiltin(url))
    const edges = new Map<string, Set<string>>()
    await Promise.all(urls.map(async url => edges.set(url, await caches.edges(url))))

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
      return closure([...attempt.stale.urls, ...attempt.imported], edges, url => retained.has(url))
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
   * Find every loaded module that exports a registered plugin, through its
   * ESM namespace or the exports of its CJS module, so that a plugin that
   * only `require()` has loaded is found too. When anything in the dependency
   * tree of such a module changes, the module is imported again and the
   * plugin is replaced.
   */
  private _discover(declined: Set<string>) {
    const candidates = new Map<string, Plugin>()
    for (const url of this._modules.urls()) {
      if (declined.has(url) || isBuiltin(url)) continue
      for (const exports of [() => this._modules.namespace(url), () => this._modules.exports(url)]) {
        let plugin: Plugin | undefined
        try {
          // reading a binding that has not been initialized throws
          plugin = unwrapExports(exports())
        } catch {
          continue
        }
        if (!plugin || !this.ctx.registry.has(plugin)) continue
        candidates.set(url, plugin)
        break
      }
    }
    return candidates
  }

  /**
   * Locate a module of a stale plugin again through the removed resolutions
   * to it, so that a module that has moved, e.g. to a new `exports` target or
   * through a retargeted link, is imported at its new URL. A resolution
   * counts if it records a request and if its parent is not evicted, since an
   * evicted parent resolves its imports again by itself. Without one, the
   * module is imported at its URL. Resolutions that now lead to different
   * modules are ambiguous: the fibers of the plugin do not record the import
   * that each of them comes from.
   */
  private _locate(url: string, removed: Resolution[], evicted: Set<string>) {
    const sources = removed.filter((resolution) => {
      return resolution.url === url && !evicted.has(resolution.parentURL) && isRequest(resolution)
    })
    if (!sources.length) return { url }
    const targets = new Set(sources.map(source => resolveRequest(this._loader, source)))
    if (targets.size > 1) {
      throw new SkipError(Hmr.SkipReason.AmbiguousImport)
    }
    return { url: [...targets][0], source: sources[0] }
  }

  /**
   * The loaded modules outside `matched` that a removed resolution now
   * resolves past. An ESM parent that links the previous result is changed,
   * so that it resolves its imports again. Otherwise the module was imported
   * dynamically, such as a plugin entry, and is changed itself, so that it is
   * imported again where the request now leads. A resolution that fails now
   * counts as resolving past its result.
   *
   * CJS records no request, so a CJS module below `<dir>` is changed if a
   * root is `<dir>/node_modules/<name>`, which a package added there may
   * shadow, and a child of the module belongs to a package `<name>` in a
   * `node_modules` above `<dir>`; reloading a module that requested the child
   * otherwise is only unnecessary.
   */
  private async _moved(roots: Set<string>, matched: Set<string>, removed: Resolution[]) {
    const moved = new Set<string>()
    for (const resolution of removed) {
      const { parentURL, url } = resolution
      if (matched.has(parentURL) || matched.has(url) || !this._modules.has(url)) continue
      const links = (await this._modules.edges(parentURL)).has(url)
      if (!links && !isRequest(resolution)) continue
      let target: string | undefined
      try {
        target = resolveRequest(this._loader, resolution)
      } catch {}
      if (target !== url) moved.add(links ? parentURL : url)
    }

    const locations = [...roots].flatMap(root => locatePackage(root) ?? [])
    if (!locations.length) return moved
    for (const url of this._modules.urls()) {
      const path = toPath(url)
      if (!path) continue
      for (const { name, dir } of locations) {
        if (!contains(dir, path)) continue
        const marker = `${sep}node_modules${sep}${name.split('/').join(sep)}${sep}`
        const shadows = this._modules.children(url).some((child) => {
          const childPath = toPath(child)
          const index = childPath?.lastIndexOf(marker) ?? -1
          if (index === -1) return false
          const above = childPath!.slice(0, index)
          return above !== dir && contains(above, dir)
        })
        if (shadows) moved.add(url)
      }
    }
    return moved
  }

  /**
   * The loaded modules whose files are one of `roots` or lie below one of
   * them. A root that matches no loaded module is logged.
   */
  private _match(roots: Set<string>) {
    const matched = new Set<string>()
    const used = new Set<string>()
    // A module is loaded if it is in either module cache. In Node 24, a CJS
    // module imported via import() is in both of them.
    for (const url of this._modules.urls()) {
      let path = toPath(url)
      if (!path) continue
      // The ancestors are looked up instead of comparing prefixes, so that a
      // root matches whole path segments only.
      while (true) {
        if (roots.has(path)) {
          matched.add(url)
          used.add(path)
        }
        const parent = dirname(path)
        if (parent === path) break
        path = parent
      }
    }
    for (const root of roots) {
      if (!used.has(root)) this.ctx.logger.debug('skip %C (no loaded module)', relative(this.baseDir, root))
    }
    return matched
  }

  private async _reconcile(callback: () => Awaitable<Iterable<string>>): Promise<Hmr.Result> {
    const result: Hmr.Result = { settled: [], aborted: [], skipped: [] }
    const roots = new Set<string>()
    for (const root of await callback()) {
      if (typeof root !== 'string' || !isAbsolute(root)) {
        throw new TypeError(`invalid root ${JSON.stringify(root)}, expected an absolute path`)
      }
      // `resolve()` normalizes the path and removes a trailing separator
      roots.add(resolve(root))
    }
    // after the callback, so that a module job that failed during it is removed too
    const caches = this._modules
    await caches.sweep()
    if (!roots.size) return result

    // also when the roots match no loaded module, e.g. a changed manifest
    const removed = invalidateResolution(roots)

    const matched = this._match(roots)
    const changed = new Set<string>()
    for (const url of new Set([...matched, ...await this._moved(roots, matched, removed)])) {
      // A change to a host module or to a loaded native addon cannot be
      // applied in place. It is skipped, and restarting is up to the caller.
      if (this.hostModules.has(url)) {
        result.skipped.push({ urls: [url], reason: Hmr.SkipReason.HostModule })
      } else if (isNativeAddon(url)) {
        result.skipped.push({ urls: [url], reason: Hmr.SkipReason.NativeAddon })
      } else {
        changed.add(url)
      }
    }
    if (!changed.size) return result

    const { accepted, declined, edges } = await this._analyze(changed)
    const oldEdges = (url: string) => edges.get(url) ?? []

    // A plugin may be exported by several modules, e.g. an entry module that
    // re-exports its implementation. All of them are imported again together.
    const exporters = new Map<Plugin.Runtime, Map<string, Plugin>>()
    for (const [url, plugin] of this._discover(declined)) {
      const runtime = this.ctx.registry.get(plugin)!
      let exported = exporters.get(runtime)
      if (!exported) exporters.set(runtime, exported = new Map())
      exported.set(url, plugin)
    }

    // The closure of a plugin consists of its modules and the accepted modules
    // they reach through accepted modules. It includes the modules of another
    // plugin, so that a plugin importing another one shares its unit.
    const stalePlugins: StalePlugin[] = []
    const evicted = new Set(accepted)
    const owned = new Set<string>()
    for (const exported of exporters.values()) {
      const urls = [...exported.keys()]
      const own = new Set(urls)
      const stop = (url: string) => declined.has(url) && !own.has(url)
      const closures = new Map<string, Set<string>>()
      for (const url of urls) {
        closures.set(url, await closure([url], oldEdges, stop))
      }
      const modules = new Set([...closures.values()].flatMap(closure => [...closure]))
      if (![...modules].some(url => accepted.has(url))) continue
      for (const url of modules) {
        evicted.add(url)
        owned.add(url)
      }

      // Use a module that no other module of the plugin imports.
      // Ambiguous aliases are deferred to the module/plugin identity work.
      const outermost = urls.filter(url => !urls.some(other => other !== url && closures.get(other)!.has(url)))
      const url = outermost[0] ?? urls[0]
      stalePlugins.push({
        url,
        plugin: exported.get(url)!,
        urls,
        entries: outermost.length ? outermost : [url],
        modules,
      })
    }

    for (const url of changed) {
      if (!owned.has(url)) this.ctx.logger.debug('evict %C (no dependent plugin)', this._relative(url))
    }

    // A CJS module imported via import() is in both caches, and both are
    // cleared, so that neither serves the old module.
    const backup = caches.evict(evicted)

    // Stage 1: import the new modules of every stale plugin.
    // Plugin validity is checked here, where the only mutated state is the
    // module cache and no plugin has been touched yet. Moving this check
    // earlier is what allows the later stages to have no rollback at all: a malformed
    // export can no longer fail halfway through swapping instances.
    // No cache entry is restored before every plugin has been imported, so
    // that no new module links against an old module that has been evicted.
    const retained = caches.urls()
    const attempts: ImportAttempt[] = []
    for (const stale of stalePlugins) {
      const before = caches.urls()
      const attempt: ImportAttempt = { stale, imported: [], loaded: [], failed: false }
      // The new module is recorded before it is imported, so that the new
      // module graph is taken from it also when the import fails.
      const load = async (url: string) => {
        const { url: target, source } = this._locate(url, removed, evicted)
        attempt.imported.push(target)
        // through the request, which records it in the resolve cache again
        return unwrapExports(await (source
          ? this._loader.import(source.specifier, source.parentURL, source.attributes)
          : this._loader.import(url, import.meta.url, {})))
      }
      try {
        // Import the other entries of the plugin too, so that their failures
        // abort its unit as well. A module that another entry imports is
        // imported through it, also when it has moved.
        const others: unknown[] = []
        for (const url of stale.entries) {
          if (url !== stale.url) others.push(await load(url))
        }
        const exports = await load(stale.url)
        if (!this.ctx.registry.resolve(exports)) {
          throw new Error(`invalid plugin at ${this._relative(stale.url)}, `
            + `expect function or object with an "apply" method, received ${typeof exports}`)
        }
        // the fibers of the plugin do not record which module each comes from
        if (others.some(other => other !== exports)) {
          throw new SkipError(Hmr.SkipReason.AmbiguousExport)
        }
        attempt.replacement = exports
      } catch (error) {
        if (error instanceof SkipError) {
          attempt.skip = error.reason
        } else {
          handleError(this.ctx, error)
          attempt.failed = true
          attempt.error = error
        }
      }
      for (const url of caches.urls()) {
        if (!before.has(url) && !evicted.has(url)) attempt.loaded.push(url)
      }
      attempts.push(attempt)
    }

    // The new module graph is read once, before any cache entry is restored.
    const newGraph = new Map<string, Promise<Set<string>>>()
    const newEdges = (url: string) => {
      let edges = newGraph.get(url)
      if (!edges) newGraph.set(url, edges = caches.edges(url))
      return edges
    }

    // A unit is a connected component of the stale plugins, where two plugins
    // are connected if their closures share an evicted module. The closure of a
    // plugin is taken in both the old module graph and the new one, so that
    // every evicted module that is imported again belongs to a single unit.
    // A unit is aborted if an attempt failed, and otherwise skipped if an
    // attempt cannot be applied in place. Both are restored alike.
    const units = await this._partition(attempts, evicted, newEdges, retained)
    const aborted = units.filter(unit => unit.attempts.some(attempt => attempt.failed))
    const skipped = units.filter(unit => !aborted.includes(unit) && unit.attempts.some(attempt => attempt.skip))
    const committed = units.filter(unit => !aborted.includes(unit) && !skipped.includes(unit))
    const kept = [...aborted, ...skipped]

    // An evicted module outside every unit is restored with the kept units it
    // reaches in the old module graph, so that it links against the modules
    // they restore. If it also reaches a committed unit, neither version is
    // consistent with the caches, and it is left evicted.
    const unowned = new Set(evicted)
    for (const unit of units) unit.modules.forEach(url => unowned.delete(url))
    for (const url of unowned) {
      const reached = await closure([url], oldEdges, url => !evicted.has(url))
      const overlaps = (unit: ReconcileUnit) => [...unit.modules].some(url => reached.has(url))
      if (committed.some(overlaps)) continue
      for (const unit of kept.filter(overlaps)) unit.modules.add(url)
    }

    // A module first loaded in stage 1 is removed from the caches if it reaches
    // a module to be restored in the new module graph, since it has been linked
    // against the new version. Any other one is kept, including one loaded by an
    // aborted or skipped unit, so that a committed unit that imported it, statically or
    // dynamically, shares its instance with later imports. A job of it that
    // failed is removed at the start of the next transaction.
    const restored = new Set(kept.flatMap(unit => [...unit.modules]))
    for (const url of attempts.flatMap(attempt => attempt.loaded)) {
      const reached = await closure([url], newEdges, url => retained.has(url))
      if ([...reached].some(url => restored.has(url))) caches.evict([url])
    }
    backup.restore(restored)
    // The resolutions to and from the restored modules are restored too, so
    // that the resolve cache records the requests that loaded them. A request
    // from a parent that is not restored still resolves to a restored module,
    // e.g. the import of a plugin entry, unless the parent has been replaced
    // and resolves its imports again by itself.
    const replaced = new Set([...evicted].filter(url => !restored.has(url)))
    restoreResolutions(removed.filter(({ parentURL, url }) => {
      return (restored.has(url) || restored.has(parentURL)) && !replaced.has(url) && !replaced.has(parentURL)
    }))

    for (const unit of aborted) {
      const failure = unit.attempts.find(attempt => attempt.failed)!
      result.aborted.push({ urls: [...unit.modules], error: failure.error })
    }
    for (const unit of skipped) {
      const skip = unit.attempts.find(attempt => attempt.skip)!
      result.skipped.push({ urls: [...unit.modules], reason: skip.skip! })
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
    result.settled = fibers.filter(fiber => fiber.uid !== null)

    return result
  }
}

namespace Hmr {
  export interface WatchConfig {
    enabled: boolean
    files: string[]
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
      files: z.array(String).role('table').default([
        '.',
        '!**/node_modules',
        '!**/.*',
      ]).description('Files to watch, in glob patterns relative to `base`, as `filter` of `ctx.fs.watch()`.'),
      debounce: z.natural().role('ms').default(100).description('Debounce changes before reloading, in milliseconds.'),
    }).description('Watch'),
  })

  /**
   * The running state is brought in line with the changes, as far as they can
   * be applied. Each change is applied, aborted or skipped.
   */
  export interface Result {
    /** the replaced fibers; a fiber whose new plugin fails to apply is left `FAILED` */
    settled: Fiber[]
    /** the units whose new modules fail to import; a later transaction retries them */
    aborted: Abort[]
    /** the changes that cannot be applied in place; a restart applies them */
    skipped: Skip[]
  }

  /**
   * A new module of a unit failed to import, or does not export a plugin.
   * Nothing in the unit is applied: its module cache is restored, and so are
   * the resolutions to its modules. A later transaction retries the unit if
   * its roots include those that changed the unit, e.g. a manifest that moved
   * an entry, since the restored resolutions lead to the previous modules.
   * The other units of the transaction are not affected.
   */
  export interface Abort {
    /** the evicted modules of the unit, whose cache entries are restored */
    urls: string[]
    /** the first error raised while importing the unit */
    error: unknown
  }

  /**
   * A change that cannot be applied in place. The other changes are applied.
   * The modules of a skipped unit are restored, as those of an aborted one.
   */
  export interface Skip {
    /** the changed module, or the evicted modules of the unit */
    urls: string[]
    reason: SkipReason
  }

  /** Why a change cannot be applied in place. */
  export const enum SkipReason {
    /** The module is reached statically from the main entry point, which runs once. */
    HostModule = 'host-module',
    /** The module is a native addon, which a process cannot load again. */
    NativeAddon = 'native-addon',
    /**
     * The imports that resolved to a plugin module now resolve to different
     * modules, e.g. after only one of two links to a package is retargeted.
     * A fiber does not record which import it comes from.
     */
    AmbiguousImport = 'ambiguous-import',
    /**
     * The modules that exported one plugin now export different values. A
     * fiber does not record which module it comes from.
     */
    AmbiguousExport = 'ambiguous-export',
  }
}

export default Hmr
