import Module from 'node:module'
import { ModuleLoader, requireInternal } from './internal.ts'
import { getState } from './state.ts'

/**
 * Node's caches from a request to the resolved module: `ResolveCache` of the
 * ESM loader and `Module._pathCache` of CommonJS. Neither checks that its
 * result still exists.
 */
export class ResolutionCaches {
  constructor(private _loader: ModuleLoader) {}

  /**
   * Make later resolutions observe the file system below `paths`, the real
   * paths that have changed. The caches are cleared as a whole, since an
   * entry can depend on a manifest outside `paths`.
   */
  invalidate(paths: Iterable<string>) {
    if ([...paths].length === 0) return
    const resolveCache = this._resolveCache()
    if (resolveCache) Map.prototype.clear.call(resolveCache)
    const pathCache: Record<string, string> = (Module as any)._pathCache
    for (const key in pathCache) delete pathCache[key]
  }

  private _resolveCache() {
    const state = getState()
    if (!state) return
    return state.resolveCache ??= captureResolveCache(this._loader)
  }
}

/**
 * Capture the private `ResolveCache` as the receiver of its `get` during one
 * resolution. Synchronous hooks are removed meanwhile, since one may skip the
 * default step, which is where the cache is looked up.
 */
function captureResolveCache(loader: ModuleLoader): Map<unknown, unknown> | undefined {
  const prototype = requireInternal('internal/modules/esm/module_map')?.ResolveCache?.prototype
  if (typeof prototype?.get !== 'function') return
  const { get } = prototype
  const hooks: unknown[] | undefined = requireInternal('internal/modules/customization_hooks')?.resolveHooks
  const registered = Array.isArray(hooks) ? hooks.splice(0) : []
  let instance: Map<unknown, unknown> | undefined
  prototype.get = function (this: Map<unknown, unknown>, ...args: unknown[]) {
    instance ??= this
    return get.apply(this, args)
  }
  try {
    if (loader.version === 'v2') {
      loader.resolveSync(import.meta.url, { specifier: import.meta.url, attributes: {} })
    } else {
      loader.resolveSync(import.meta.url, import.meta.url, {})
    }
  } catch {} finally {
    prototype.get = get
    hooks?.unshift(...registered)
  }
  return instance
}
