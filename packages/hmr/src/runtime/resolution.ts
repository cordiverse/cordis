import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import Module from 'node:module'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ModuleLoader, requireInternal } from './internal.ts'
import { invalidateManifests } from './patches.ts'

/** Node's private resolution caches. */
interface Captured {
  resolve?: Map<unknown, unknown>
  realpath: {
    esm?: Map<unknown, unknown>
    /** may be the ESM one */
    cjs?: Map<unknown, unknown>
  }
}

/** The resolution caches that {@link invalidateResolution} can clear in this thread. */
export interface ResolutionSupport {
  /** Whether the realpath caches of ESM and CJS are cleared; for ESM, on Node 24.16+ and 26.1+. */
  realpath: boolean
}

let captured: Captured | undefined

/** The private caches, captured at the first use; a failed probe is tried again. */
function getCaptured() {
  if (captured) return captured
  const loader = ModuleLoader.fromInternal()
  if (!loader) return
  const result = capture(loader)
  if (result.complete) captured = result.captured
  return result.captured
}

export function getResolutionSupport(): ResolutionSupport {
  const captured = getCaptured()
  return { realpath: !!captured?.realpath.esm && !!captured.realpath.cjs }
}

/** A resolution of the ESM resolve cache: a request from `parentURL` and the URL it resolved to. */
export interface Resolution {
  /** as the default resolution received it, after synchronous hooks */
  specifier: string
  attributes: Record<string, string>
  parentURL: string
  url: string
}

/**
 * Make later resolutions observe the file system below `paths`, which may be
 * spelled through links:
 *
 * - the entries of the ESM resolve cache that a change below `paths` can
 *   affect are removed: those whose result or parent lies below one of
 *   `paths`, and those that resolve a package name from below a directory
 *   that one of `paths` adds it to as `node_modules/<name>`. A manifest stands
 *   for its directory;
 * - the CJS path cache and the realpath caches are cleared as a whole;
 * - a manifest at or below one of `paths`, as spelled or at the real path of
 *   its directory, is read from disk from now on, through the replacements of
 *   `activate()`, which must be in place.
 *
 * The entries kept in the resolve cache record the requests that resolved to
 * each module; the removed ones are returned, so that a module can be
 * imported again through the requests that resolved to it.
 */
export function invalidateResolution(paths: Iterable<string>): Resolution[] {
  const list = [...paths]
  if (!list.length) return []
  const pathCache: Record<string, string> = (Module as any)._pathCache
  for (const key in pathCache) delete pathCache[key]
  invalidateManifests(list)
  const captured = getCaptured()
  if (!captured) return []
  const { resolve, realpath } = captured
  for (const cache of new Set([realpath.esm, realpath.cjs])) {
    if (cache) Map.prototype.clear.call(cache)
  }
  return resolve ? removeResolutions(resolve, list) : []
}

/**
 * Remove the entries that a change below `paths` can affect. The resolve
 * cache maps a parent URL to an object from a serialized request to a
 * result, see `ResolveCache` of `internal/modules/esm/module_map`.
 */
function removeResolutions(cache: Map<unknown, unknown>, paths: string[]) {
  const roots = new Set<string>()
  // for a package name, the directories below which it resolves to one of `paths`
  const locations = new Map<string, Set<string>>()
  for (let path of paths) {
    path = resolve(path)
    if (basename(path) === 'package.json') path = dirname(path)
    roots.add(path)
    const location = locatePackage(path)
    if (!location) continue
    let dirs = locations.get(location.name)
    if (!dirs) locations.set(location.name, dirs = new Set())
    dirs.add(location.dir)
  }
  const affects = (parentURL: unknown, request: { specifier: string } | undefined, url: unknown) => {
    // a result that cannot be read is removed
    if (typeof url !== 'string' || within(roots, toPath(url))) return true
    const parent = typeof parentURL === 'string' ? toPath(parentURL) : undefined
    if (within(roots, parent)) return true
    const dirs = request && locations.get(packageName(request.specifier)!)
    return !!dirs && within(dirs, parent)
  }
  const removed: Resolution[] = []
  for (const [parentURL, imports] of [...Map.prototype.entries.call(cache)] as [unknown, Record<string, any>][]) {
    for (const key of Object.keys(imports)) {
      const url: unknown = imports[key]?.url
      const request = parseKey(key)
      if (!affects(parentURL, request, url)) continue
      delete imports[key]
      if (request && typeof url === 'string' && typeof parentURL === 'string') {
        removed.push({ ...request, parentURL, url })
      }
    }
  }
  return removed
}

/**
 * Parse a request serialized as `<specifier>::<attributes>`, whose attributes
 * are sorted pairs of JSON strings joined by commas.
 */
function parseKey(key: string) {
  const pair = /"(?:[^"\\]|\\.)*""(?:[^"\\]|\\.)*"/
  const format = new RegExp(`^(?:${pair.source}(?:,${pair.source})*)?$`)
  for (let index = key.lastIndexOf('::'); index !== -1; index = key.lastIndexOf('::', index - 1)) {
    const serialized = key.slice(index + 2)
    if (!format.test(serialized)) continue
    const attributes: Record<string, string> = {}
    for (const [, name, value] of serialized.matchAll(/("(?:[^"\\]|\\.)*")("(?:[^"\\]|\\.)*")/g)) {
      attributes[JSON.parse(name)] = JSON.parse(value)
    }
    return { specifier: key.slice(0, index), attributes }
  }
}

/**
 * The package that `path` is the location of, if it is `<dir>/node_modules/<name>`,
 * and the directory below which a package name resolves to it.
 */
export function locatePackage(path: string) {
  const scoped = basename(dirname(path)).startsWith('@')
  const modules = scoped ? dirname(dirname(path)) : dirname(path)
  if (basename(modules) !== 'node_modules') return
  const name = scoped ? `${basename(dirname(path))}/${basename(path)}` : basename(path)
  return { name, dir: dirname(modules) }
}

/** The package name of a bare specifier. */
export function packageName(specifier: string) {
  if (/^(?:[./#]|[a-z][a-z\d+.-]*:)/i.test(specifier)) return
  const [scope, name] = specifier.split('/', 2)
  return scope.startsWith('@') ? name && `${scope}/${name}` : scope
}

function toPath(url: string) {
  if (!url.startsWith('file:')) return
  try {
    return fileURLToPath(url)
  } catch {}
}

/** Whether `path` is one of `roots` or lies below one, along whole path segments. */
function within(roots: Set<string>, path: string | undefined) {
  while (path) {
    if (roots.has(path)) return true
    const parent = dirname(path)
    if (parent === path) return false
    path = parent
  }
  return false
}

/** Resolve a recorded request again, with the synchronous hooks. */
export function resolveRequest(loader: ModuleLoader, { specifier, attributes, parentURL }: Resolution): string {
  return loader.version === 'v2'
    ? loader.resolveSync(parentURL, { specifier, attributes }).url
    : loader.resolveSync(specifier, parentURL, attributes).url
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
