import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import Module from 'node:module'
import { pathToFileURL } from 'node:url'
import { ModuleLoader, requireInternal } from './internal.ts'
import { invalidateManifests } from './manifests.ts'
import { Captured, getState } from './state.ts'

/** The resolution caches that {@link ResolutionCaches.invalidate} can clear in this thread. */
export interface ResolutionSupport {
  /** Whether the realpath caches of ESM and CJS are cleared; for ESM, on Node 24.16+ and 26.1+. */
  realpath: boolean
}

/** Node's caches from a request to the resolved module. */
export class ResolutionCaches {
  constructor(private _loader: ModuleLoader) {}

  get support(): ResolutionSupport {
    const captured = this._captured()
    return { realpath: !!captured?.realpath.esm && !!captured.realpath.cjs }
  }

  /**
   * Make later resolutions observe the file system below `paths`, which may
   * be spelled through links. The caches are cleared as a whole, since an
   * entry can depend on a manifest outside `paths`. A manifest at or below
   * one of `paths`, as spelled or at the real path of its directory, is read
   * from disk from now on.
   *
   * The first call replaces Node's manifest readers and `Module._load` for
   * the lifetime of the thread, since Node's manifest caches cannot be
   * cleared. CJS requests are then resolved before `Module._load`, which
   * receives them under another key.
   */
  invalidate(paths: Iterable<string>) {
    const list = [...paths]
    if (!list.length) return
    const pathCache: Record<string, string> = (Module as any)._pathCache
    for (const key in pathCache) delete pathCache[key]
    invalidateManifests(list)
    const captured = this._captured()
    if (!captured) return
    const { resolve, realpath } = captured
    for (const cache of new Set([resolve, realpath.esm, realpath.cjs])) {
      if (cache) Map.prototype.clear.call(cache)
    }
  }

  private _captured() {
    const state = getState()
    if (!state) return
    if (state.captured) return state.captured
    const { captured, complete } = capture(this._loader)
    // a failed probe is tried again
    if (complete) state.captured = captured
    return captured
  }
}

/**
 * Capture the private caches through one ESM and one CJS resolution of the
 * Node executable, a file that no package update moves.
 */
function capture(loader: ModuleLoader) {
  const captured: Captured = { realpath: {} }
  const key: symbol | undefined = requireInternal('internal/fs/utils')?.realpathCacheKey
  const { realpathSync } = fs
  let realpathCache: Map<unknown, unknown> | undefined
  fs.realpathSync = Object.assign(function (this: unknown, ...args: Parameters<typeof realpathSync>) {
    const options: any = args[1]
    if (key && options?.[key]) realpathCache ??= options[key]
    return realpathSync.apply(this, args)
  }, { native: realpathSync.native }) as typeof realpathSync
  try {
    const esm = captureESM(loader)
    captured.resolve = esm.resolveCache
    captured.realpath.esm = realpathCache
    realpathCache = undefined
    const cjs = captureCJS()
    captured.realpath.cjs = realpathCache
    return { captured, complete: esm.complete && cjs }
  } finally {
    fs.realpathSync = realpathSync
  }
}

/**
 * A query unique to each attempt misses `ResolveCache`, so that the realpath
 * step is reached. Synchronous hooks are removed meanwhile, since one may
 * skip the default step.
 */
function captureESM(loader: ModuleLoader) {
  const prototype = requireInternal('internal/modules/esm/module_map')?.ResolveCache?.prototype
  if (typeof prototype?.get !== 'function') return { complete: true }
  const { get } = prototype
  const hooks: unknown[] | undefined = requireInternal('internal/modules/customization_hooks')?.resolveHooks
  const registered = Array.isArray(hooks) ? hooks.splice(0) : []
  let resolveCache: Map<unknown, unknown> | undefined
  prototype.get = function (this: Map<unknown, unknown>, ...args: unknown[]) {
    resolveCache ??= this
    return get.apply(this, args)
  }
  const specifier = `${pathToFileURL(process.execPath).href}?cordis-hmr-capture=${randomUUID()}`
  let complete = true
  try {
    if (loader.version === 'v2') {
      loader.resolveSync(specifier, { specifier, attributes: {} })
    } else {
      loader.resolveSync(specifier, specifier, {})
    }
  } catch {
    complete = false
  } finally {
    prototype.get = get
    hooks?.unshift(...registered)
  }
  return { resolveCache, complete }
}

/** An empty `Module._pathCache` makes the lookup reach the realpath step. */
function captureCJS() {
  const pathCache = (Module as any)._pathCache
  ;(Module as any)._pathCache = { __proto__: null }
  try {
    return !!(Module as any)._findPath(process.execPath, null, false)
  } catch {
    return false
  } finally {
    (Module as any)._pathCache = pathCache
  }
}
