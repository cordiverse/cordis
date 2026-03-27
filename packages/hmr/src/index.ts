import { Context, Inject, Plugin, Service } from 'cordis'
import { Dict } from 'cosmokit'
import { ModuleJob, ModuleLoader, ResolveResult } from '@cordisjs/plugin-loader'
import { ChokidarOptions, FSWatcher, watch } from 'chokidar'
import { relative, resolve } from 'node:path'
import { handleError } from './error.ts'
import type {} from '@cordisjs/plugin-timer'
import type {} from '@cordisjs/plugin-logger'
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
    'hmr/reload'(reloads: Map<Plugin, Reload>): void
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
    if (job.url.startsWith('node:') || job.url.includes('/node_modules/')) return
    dependencies.add(job.url)
    const children = await job.linked
    await Promise.all(Array.prototype.map.call(children, traverse))
  }
  await traverse(job)
  return dependencies
}

interface Reload {
  filename: string
  runtime?: Plugin.Runtime
}

@Inject('loader')
@Inject('timer')
@Inject('logger')
class Hmr extends Service {
  private base: string
  private internal: ModuleLoader
  private watcher!: FSWatcher

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
    if (!this.ctx.loader.internal) {
      throw new Error('--expose-internals is required for HMR service')
    }
    this.internal = this.ctx.loader.internal
    this.base = resolve(ctx.baseDir, config.base || '')
  }

  /**
   * Get a ModuleJob for a specifier, compatible with Node 22-24.
   */
  private _getModuleJob(specifier: string, parentURL: string, attributes: ImportAttributes) {
    switch (this.internal.version) {
      case 'v1': return this.internal.getModuleJobForImport(specifier, parentURL, attributes)
      case 'v2': return this.internal.getOrCreateModuleJob(parentURL, { specifier, attributes })
    }
  }

  /**
   * Resolve a module specifier to a URL, compatible with Node 22-24.
   */
  private async _resolve(specifier: string, parentURL: string, attrs: ImportAttributes): Promise<ResolveResult> {
    switch (this.internal.version) {
      case 'v1': return await this.internal.resolve(specifier, parentURL, attrs)
      case 'v2': return this.internal.resolveSync(parentURL, { specifier, attributes: attrs })
    }
  }

  relative(filename: string) {
    if (!this.base) return filename
    return relative(this.base, filename)
  }

  async* [Service.init]() {
    yield () => this.watcher?.close()

    const { loader } = this.ctx
    const { root, ignored } = this.config
    if (this.base === this.ctx.baseDir) {
      this.ctx.logger.debug('watching %o', root)
    } else {
      this.ctx.logger.debug('watching %o in %s', root, this.base)
    }

    const match = picomatch(ignored)
    this.watcher = watch(root, {
      ...this.config,
      cwd: this.base,
      ignored: path => match(relative(this.base, path)),
    })

    // Collect externals: framework modules reachable from the main entry.
    // Changes to these files require a full process restart, not HMR.
    const mainUrl = pathToFileURL(resolve(process.argv[1])).href
    const mainJob = this.internal.loadCache.get(mainUrl)
    if (mainJob) {
      this.externals = await loadDependencies(mainJob)
    } else {
      this.externals = new Set()
    }

    const partialReload = this.ctx.debounce(() => this.partialReload(), this.config.debounce)

    this.watcher.on('change', async (path) => {
      this.ctx.logger.debug('change detected at %c', path)
      const url = pathToFileURL(resolve(this.base, path)).href

      // Full reload: the changed file is part of the framework
      if (this.externals.has(url)) return loader.exit()

      // Partial reload: the file is in the ESM loadCache
      // In Node 24, both CJS and ESM modules imported via import() end up
      // in loadCache, so this check covers all module formats.
      if (loader.internal!.loadCache.has(url)) {
        this.stashed.add(url)
        return partialReload()
      }

      // Config reload: the file is a loader config file (e.g. cordis.yml)
      const file = this.ctx.loader.files[url]
      if (!file) return
      await file.refresh()
    })
  }

  // hide stack trace from HMR
  getOuterStack = (): string[] => [
    // '    at HMR.partialReload (<anonymous>)',
  ]

  async getLinked(filename: string) {
    const job = this.internal.loadCache.get(pathToFileURL(filename).toString())
    if (!job) return []
    const linked = await job.linked
    return linked.map(job => fileURLToPath(job.url))
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

    await Promise.all([...this.stashed].map(async (filename) => {
      const children = await this.getLinked(filename)
      for (const filename of children) {
        if (this.accepted.has(filename) || this.declined.has(filename) || filename.includes('/node_modules/')) continue
        pending.push(filename)
      }
    }))

    while (pending.length) {
      let index = 0, hasUpdate = false
      while (index < pending.length) {
        const filename = pending[index]
        const children = await this.getLinked(filename)
        let isDeclined = true, isAccepted = false
        for (const filename of children) {
          if (this.declined.has(filename) || filename.includes('/node_modules/')) continue
          if (this.accepted.has(filename)) {
            isAccepted = true
            break
          } else {
            isDeclined = false
            if (!pending.includes(filename)) {
              hasUpdate = true
              pending.push(filename)
            }
          }
        }
        if (isAccepted || isDeclined) {
          hasUpdate = true
          pending.splice(index, 1)
          if (isAccepted) {
            this.accepted.add(filename)
          } else {
            this.declined.add(filename)
          }
        } else {
          index++
        }
      }
      if (!hasUpdate) break
    }

    for (const filename of pending) {
      this.declined.add(filename)
    }
  }

  private async partialReload() {
    await this.analyzeChanges()

    const pending = new Map<ModuleJob, Plugin>()
    const reloads = new Map<Plugin, Reload>()

    // Build a map of plugin names per config tree URL.
    // Plugin entry files are treated as atomic reload units.
    const nameMap: Dict<Set<string>> = Object.create(null)
    for (const entry of this.ctx.loader.entries()) {
      (nameMap[entry.parent.tree.url] ??= new Set()).add(entry.options.name)
    }

    // Resolve each plugin name to its file URL and check if it needs reload
    for (const baseURL in nameMap) {
      for (const name of nameMap[baseURL]) {
        try {
          const { url } = await this._resolve(name, baseURL, {})
          if (this.declined.has(url)) continue
          const job = this.internal.loadCache.get(url)
          const plugin = this.ctx.loader.unwrapExports(job?.module?.getNamespace())
          if (!job || !plugin) continue
          pending.set(job, plugin)
          this.declined.add(url)
        } catch (err) {
          this.ctx.logger.warn(err)
        }
      }
    }

    // Check each pending plugin's dependency tree for accepted files
    for (const [job, plugin] of pending) {
      this.declined.delete(job.url)
      const dependencies = [...await loadDependencies(job, this.declined)]
      this.declined.add(job.url)

      if (!dependencies.some(dep => this.accepted.has(dep))) continue
      dependencies.forEach(dep => this.accepted.add(dep))

      reloads.set(plugin, {
        filename: job.url,
        runtime: this.ctx.registry.get(plugin),
      })
    }

    /**
     * Clear module caches for all accepted files before re-importing.
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
    for (const filename of this.accepted) {
      // Backup and clear ESM loadCache
      const job = Map.prototype.get.call(this.internal.loadCache, filename)
      esmBackup[filename] = job
      Map.prototype.delete.call(this.internal.loadCache, filename)

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
        Map.prototype.set.call(this.internal.loadCache, filename, esmBackup[filename])
      }
      for (const filepath in cjsBackup) {
        require.cache[filepath] = cjsBackup[filepath]
      }
    }

    // Attempt to re-import all plugin entry files
    const attempts: Dict = {}
    try {
      for (const [, { filename }] of reloads) {
        attempts[filename] = this.ctx.loader.unwrapExports(await this.ctx.loader.import(filename, this.getOuterStack))
      }
    } catch (e) {
      handleError(this.ctx, e)
      return rollback()
    }

    const reload = (plugin: any, runtime: Plugin.Runtime) => {
      if (!runtime) return
      for (const oldFiber of runtime.fibers) {
        const fiber = oldFiber.parent.registry.plugin(plugin, oldFiber.config, this.getOuterStack)
        fiber.entry = oldFiber.entry
        if (fiber.entry) fiber.entry.fiber = fiber
      }
    }

    try {
      for (const [plugin, { filename, runtime }] of reloads) {
        if (!runtime) continue
        const path = this.relative(fileURLToPath(filename))

        try {
          this.ctx.registry.delete(plugin)
        } catch (err) {
          this.ctx.logger.warn('failed to dispose plugin at %c', path)
          this.ctx.logger.warn(err)
        }

        try {
          reload(attempts[filename], runtime)
          this.ctx.logger.info('reload plugin at %c', path)
        } catch (err) {
          this.ctx.logger.warn('failed to reload plugin at %c', path)
          this.ctx.logger.warn(err)
          throw err
        }
      }
    } catch {
      // Rollback: restore caches and re-register old plugins
      rollback()
      for (const [plugin, { filename, runtime }] of reloads) {
        if (!runtime) continue
        try {
          this.ctx.registry.delete(attempts[filename])
          reload(plugin, runtime)
        } catch (err) {
          this.ctx.logger.warn(err)
        }
      }
      return
    }

    this.ctx.emit('hmr/reload', reloads)
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
    root: z.union([
      z.array(String).role('table'),
      z.transform(String, (value) => [value]),
    ]).default(['.']),
    ignored: z.array(String).role('table').default([
      '**/node_modules/**',
      '**/.*/**',
      'cache/**',
      'data/**',
    ]),
    debounce: z.natural().role('ms').default(100),
  }).i18n({
    'en-US': enUS,
    'zh-CN': zhCN,
  })
}

export default Hmr
