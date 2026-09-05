import { Context, Fiber, Inject, Plugin, Service } from 'cordis'
import { Dict } from 'cosmokit'
import { ModuleJob, ModuleLoader, ResolveResult } from '@cordisjs/plugin-loader'
import type { Include } from '@cordisjs/plugin-include'
import { ChokidarOptions, FSWatcher, watch } from 'chokidar'
import { relative, resolve } from 'node:path'
import { handleError } from './error.ts'
import type {} from '@cordisjs/plugin-timer'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import picomatch from 'picomatch'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import z from 'schemastery'

declare module 'cordis' {
  interface Context {
    hmr: Hmr
  }

  interface Events {
    'hmr/change'(url: string): void
    'hmr/reload'(stalePlugins: Map<Plugin, StalePlugin>): void
  }
}

/**
 * Recursively collect all module dependencies from a ModuleJob.
 * Skips node: builtins and node_modules to focus on user code.
 */
async function loadDependencies(job: ModuleJob, ignored = new Set<string>()) {
  const dependencies = new Set<string>()
  async function traverse(job: ModuleJob) {
    if (ignored.has(job.url) || dependencies.has(job.url)) return
    if (isBuiltinOrExternal(job.url)) return
    dependencies.add(job.url)
    const children = await job.linked
    await Promise.all(Array.prototype.map.call(children, traverse))
  }
  await traverse(job)
  return dependencies
}

/** True for Node builtins (`node:` scheme) and node_modules dependencies — not user code for HMR. */
function isBuiltinOrExternal(url: string): boolean {
  return url.startsWith('node:') || url.includes('/node_modules/')
}

const LOADER_INTERNALS_ERROR = 'HMR module reload requires loader internals: run with --expose-internals (Node process flag) or use watch-only mode (root: [])'

/** An entry plugin whose module has changed. Keyed by the *old* plugin. */
interface StalePlugin {
  filename: string
  /** the runtime the old plugin was registered under */
  runtime?: Plugin.Runtime
}

/** One instance of a stale plugin, paired with what will replace it. */
interface StaleFiber {
  /** the entry file, relative to `baseDir`, for logging */
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

@Inject('loader')
@Inject('timer')
class Hmr extends Service {
  public baseDir: string

  private internal: ModuleLoader | undefined
  private watcher?: FSWatcher

  /** Non-null accessor: the constructor guarantees `internal` when `root.length > 0`. */
  private get requiredInternal(): ModuleLoader {
    return this.internal!
  }

  /**
   * Changes from externals will always trigger a full reload.
   * Externals are the dependency tree of the CLI worker entry point.
   */
  private externals!: Set<string>

  /**
   * Files that should be reloaded (accepted changes).
   * Includes all stashed files and their dependents.
   */
  private accepted!: Set<string>

  /**
   * Files that should NOT be reloaded.
   * Includes externals and files whose dependents are all declined.
   */
  private declined!: Set<string>

  /** Stashed file changes waiting to be processed */
  private stashed = new Set<string>()

  constructor(ctx: Context, public config: Hmr.Config) {
    super(ctx, 'hmr')
    if (this.config.root.length && !this.ctx.loader.internal) {
      throw new Error(LOADER_INTERNALS_ERROR)
    }
    this.internal = this.ctx.loader.internal
    this.baseDir = fileURLToPath(new URL(config.base || '.', ctx.baseUrl))
  }

  /**
   * Resolve a module specifier to a URL, compatible with Node 22-24.
   */
  private async _resolve(specifier: string, parentURL: string, attrs: ImportAttributes): Promise<ResolveResult> {
    const version = this.requiredInternal.version
    switch (version) {
      case 'v1': return await this.requiredInternal.resolve(specifier, parentURL, attrs)
      case 'v2': return this.requiredInternal.resolveSync(parentURL, { specifier, attributes: attrs })
      default: throw new Error(`unsupported loader internal version: ${String(version)}`)
    }
  }

  async* [Service.init]() {
    yield () => this.watcher?.close()

    const { loader } = this.ctx
    const { root, ignored } = this.config
    if (!this.config.base) {
      this.ctx.logger.info('watching %o', root)
    } else {
      this.ctx.logger.info('watching %o in %s', root, this.baseDir)
    }

    this.externals = new Set()

    // In watch-only mode (root: []) there is nothing to watch or track.
    if (this.config.root.length) {
      const match = picomatch(ignored)
      this.watcher = watch(root, {
        ...this.config,
        cwd: this.baseDir,
        ignored: path => match(relative(this.baseDir, path)),
      })

      // Collect externals: framework modules reachable from the main entry.
      // Changes to these files require a full process restart, not HMR.
      const mainUrl = pathToFileURL(resolve(process.argv[1])).href
      const mainJob = this.requiredInternal.loadCache.get(mainUrl)
      if (mainJob) this.externals = await loadDependencies(mainJob)

      const partialReload = this.ctx.debounce(() => this.partialReload(), this.config.debounce)

      this.watcher.on('change', async (path) => {
        this.ctx.logger.debug('change detected at %C', path)
        const filename = resolve(this.baseDir, path)
        const url = pathToFileURL(filename).href

        // Full reload: the changed file is part of the framework
        if (this.externals.has(url)) return loader.exit()

        // Partial reload: the file is in the ESM loadCache
        // In Node 24, both CJS and ESM modules imported via import() end up
        // in loadCache, so this check covers all module formats.
        if (this.requiredInternal.loadCache.has(url)) {
          this.stashed.add(url)
          return partialReload()
        }

        // Config reload: the file is a loader config file (e.g. cordis.yml)
        for (const entry of this.ctx.loader.entries()) {
          const include = entry.subtree as Include | undefined
          if (include?.filename !== filename) continue
          await include.refresh()
          return
        }

        this.ctx.emit('hmr/change', url)
      })
    }
  }

  // hide stack trace from HMR
  getOuterStack = (): string[] => [
    // '    at HMR.partialReload (<anonymous>)',
  ]

  async getLinked(url: string) {
    const job = this.internal?.loadCache.get(url)
    if (!job) return []
    const linked = await job.linked
    return Array.prototype.map.call(linked, (job: ModuleJob) => job.url) as string[]
  }

  /**
   * Classify changed files into accepted (should reload) and declined (should not).
   *
   * A file is accepted if it's directly changed (stashed) or if any of its
   * dependents are accepted. A file is declined if all its dependents are
   * declined or if it's an external.
   */
  private async analyzeChanges() {
    const pending: string[] = []

    this.accepted = new Set(this.stashed)
    this.declined = new Set(this.externals)

    const isExcluded = isBuiltinOrExternal

    await Promise.all([...this.stashed].map(async (url) => {
      const children = await this.getLinked(url)
      for (const child of children) {
        if (this.accepted.has(child) || this.declined.has(child) || isExcluded(child)) continue
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
          if (this.declined.has(child) || isExcluded(child)) continue
          if (this.accepted.has(child)) {
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
            this.accepted.add(url)
          } else {
            this.declined.add(url)
          }
        } else {
          index++
        }
      }
      if (!hasUpdate) break
    }

    for (const url of pending) {
      this.declined.add(url)
    }
  }

  private async partialReload() {
    await this.analyzeChanges()
    const internal = this.requiredInternal

    const candidates = new Map<ModuleJob, Plugin>()
    const invalidatedModules = new Set(this.accepted)
    const stalePlugins = new Map<Plugin, StalePlugin>()

    // Build a map of plugin names per config tree URL.
    // Plugin entry files are treated as atomic reload units.
    const nameMap: Dict<Set<string>> = Object.create(null)
    for (const entry of this.ctx.loader.entries()) {
      (nameMap[entry.parent.tree.ctx.baseUrl!] ??= new Set()).add(entry.options.name)
    }

    // Resolve each plugin name to its file URL and check if it needs reload
    for (const baseUrl in nameMap) {
      for (const name of nameMap[baseUrl]) {
        try {
          const { url } = await this._resolve(name, baseUrl, {})
          if (this.declined.has(url)) continue
          const job = internal.loadCache.get(url)
          const plugin = this.ctx.loader.unwrapExports(job?.module?.getNamespace())
          if (!job || !plugin) continue
          candidates.set(job, plugin)
          this.declined.add(url)
        } catch (err) {
          this.ctx.logger.warn(err)
        }
      }
    }

    // Check each candidate plugin's dependency tree for accepted files
    for (const [job, plugin] of candidates) {
      this.declined.delete(job.url)
      const dependencies = [...await loadDependencies(job, this.declined)]
      this.declined.add(job.url)

      if (!dependencies.some(dep => this.accepted.has(dep))) continue
      dependencies.forEach(dep => invalidatedModules.add(dep))

      stalePlugins.set(plugin, {
        filename: job.url,
        runtime: this.ctx.registry.get(plugin),
      })
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
    const replacements: Dict = {}
    try {
      for (const [, { filename, runtime }] of stalePlugins) {
        const exports = this.ctx.loader.unwrapExports(await this.ctx.loader.import(filename, this.getOuterStack))
        if (runtime && !this.ctx.registry.resolve(exports)) {
          throw new Error(`invalid plugin at ${relative(this.baseDir, fileURLToPath(filename))}, `
            + `expect function or object with an "apply" method, received ${typeof exports}`)
        }
        replacements[filename] = exports
      }
    } catch (e) {
      handleError(this.ctx, e)
      return rollback()
    }

    // Stage 2: unload (per plugin, synchronous).
    // `registry.delete()` does not block, so deleting everything up front
    // costs nothing, and it is what makes the ancestor check below decidable:
    // by the time anything is rebuilt, every fiber this batch tears down has
    // already had its `uid` cleared.
    let staleFibers: StaleFiber[] = []
    for (const [plugin, { filename, runtime }] of stalePlugins) {
      if (!runtime) continue
      const path = relative(this.baseDir, fileURLToPath(filename))

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
        staleFibers.push({ path, replacement: replacements[filename], fiber })
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
      try {
        while (fiber.inertia) await fiber.inertia

        const newFiber = fiber.parent.registry.plugin(replacement, fiber.config, this.getOuterStack)
        newFiber.entry = fiber.entry
        if (newFiber.entry) newFiber.entry.fiber = newFiber
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

    this.ctx.emit('hmr/reload', stalePlugins)
    this.stashed = new Set()
  }
}

namespace Hmr {
  export interface Config extends ChokidarOptions {
    base?: string
    root: string[]
    debounce: number
    ignored: string[]
  }

  export const Config: z<Config> = z.object({
    base: z.string(),
    root: z.array(String).role('table').default(['.']),
    ignored: z.array(String).role('table').default([
      '**/node_modules',
      '**/.*',
      'cache',
      'data',
    ]),
    debounce: z.natural().role('ms').default(100),
  }).i18n({
    'en-US': enUS,
    'zh-CN': zhCN,
  })
}

export default Hmr
