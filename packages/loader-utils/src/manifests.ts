import { isUtf8 } from 'node:buffer'
import { readFileSync, realpathSync } from 'node:fs'
import Module, { isBuiltin } from 'node:module'
import { basename, dirname, join, parse, resolve, sep, toNamespacedPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { internalBinding, requireInternal } from './internal.ts'
import { install } from './patch.ts'
import { getState } from './state.ts'

/** A manifest as serialized by Node's `modules` binding: name, main, type, imports, exports, path. */
type Manifest = [string | undefined, string | undefined, string, string | undefined, string | undefined, string]

/** The methods of `internalBinding('modules')` that read manifests through Node's native cache. */
interface Binding {
  readPackageJSON(path: string, isESM?: boolean, base?: string, specifier?: string): Manifest | undefined
  /** absent on Node 24.9–24.13 and 25.0–25.4, where the reader looks the manifest up itself */
  getNearestParentPackageJSON?(checkPath: string): Manifest | undefined
  getPackageScopeConfig(url: string): Manifest | string
  /** Node 24+ */
  getPackageType?(url: string): string | undefined
}

interface PackageJSON {
  data: object
  exists: boolean
  path: string
}

/** `internal/modules/package_json_reader`, whose nearest-manifest lookup has a cache of its own on Node 24+. */
interface Reader {
  getNearestParentPackageJSON(checkPath: string): PackageJSON | undefined
}

type Load = (request: string, parent?: Module, isMain?: boolean, ...args: unknown[]) => unknown

interface Resolution {
  /** absent on the fast path without hooks, except for `node:` requests */
  url?: string
  format?: string
  filename: string
  parentURL?: string
}

/** `resolveForCJSWithHooks` of `internal/modules/cjs/loader`: the resolution of `Module._load`, through synchronous resolve hooks. */
type ResolveForCJSWithHooks = (request: string, parent: Module, isMain?: boolean, options?: object) => Resolution

/** An entry of `resolveHooks` of `internal/modules/customization_hooks`; the last entry runs first. */
interface ResolveHook {
  resolve(specifier: string, context: { parentURL?: string }, next: (specifier: string, context: object) => unknown): unknown
}

export interface ManifestState {
  /** the invalidated paths, kept for the lifetime of the thread */
  paths: Set<string>
  /** manifests read from disk since the last invalidation, `null` if absent */
  cache: Map<string, Manifest | null>
  /** real paths of directories since the last invalidation */
  directories: Map<string, string>
}

const kDefer = Symbol('defer')

/**
 * Make later resolutions read the manifests below `paths` from disk. On the
 * first call, the methods that read Node's manifest caches and `Module._load`
 * are replaced for the lifetime of the thread, since those caches cannot be
 * cleared.
 */
export function invalidateManifests(paths: string[]) {
  const state = getState()
  if (!state) return
  const manifests = state.manifests ??= setup()
  if (!manifests) return
  for (const path of paths) manifests.paths.add(resolve(path))
  manifests.cache.clear()
  manifests.directories.clear()
}

function setup(): ManifestState | undefined {
  const binding: Binding | undefined = internalBinding('modules')
  const reader: Reader | undefined = requireInternal('internal/modules/package_json_reader')
  if (typeof binding?.readPackageJSON !== 'function') return
  if (typeof binding.getPackageScopeConfig !== 'function') return
  if (typeof reader?.getNearestParentPackageJSON !== 'function') return
  // exported wherever `module.registerHooks` exists; `Module._resolveFilename` is complete before that
  const resolveForCJSWithHooks: ResolveForCJSWithHooks | undefined = requireInternal('internal/modules/cjs/loader')?.resolveForCJSWithHooks
  const hooks: unknown = requireInternal('internal/modules/customization_hooks')?.resolveHooks
  const resolveHooks = Array.isArray(hooks) ? hooks as ResolveHook[] : undefined
  const state: ManifestState = { paths: new Set(), cache: new Map(), directories: new Map() }
  const original = {
    readPackageJSON: binding.readPackageJSON,
    getNearestParentPackageJSON: binding.getNearestParentPackageJSON,
    getPackageScopeConfig: binding.getPackageScopeConfig,
    getPackageType: binding.getPackageType,
    reader: reader.getNearestParentPackageJSON,
    load: (Module as any)._load as Load,
  }
  // Node 22 reports a missing manifest as `undefined`, Node 24+ as an object;
  // a lookup that starts in a `node_modules` directory finds none
  const absent = original.reader(join(parse(process.cwd()).root, 'node_modules', 'package.json')) !== undefined

  const readPackageJSON = (path: string, isESM?: boolean, base?: string, specifier?: string) => {
    return isInvalidated(state, path)
      ? read(state, path, isESM ? { base, specifier } : undefined)
      : original.readPackageJSON(path, isESM, base, specifier)
  }

  /** The manifest found by a lookup through `manifests`, or `kDefer` if none of them is invalidated. */
  const find = (manifests: string[], specifier?: string) => {
    const invalidated = manifests.map(path => isInvalidated(state, path))
    if (!invalidated.includes(true)) return kDefer
    for (const [index, path] of manifests.entries()) {
      const manifest = invalidated[index]
        ? read(state, path, specifier === undefined ? undefined : { specifier })
        : specifier === undefined
          ? original.readPackageJSON(path)
          : original.readPackageJSON(path, true, undefined, specifier)
      if (manifest) return manifest
    }
  }

  const getNearestParentPackageJSON = (checkPath: string) => {
    const manifest = find(nearest(checkPath))
    return manifest === kDefer ? original.getNearestParentPackageJSON!(checkPath) : manifest
  }

  const getPackageScopeConfig = (url: string) => {
    if (!url.startsWith('file:')) return original.getPackageScopeConfig(url)
    const { manifests, last } = scope(url)
    const manifest = find(manifests, url)
    return manifest === kDefer ? original.getPackageScopeConfig(url) : manifest ?? last
  }

  const getPackageType = (url: string) => {
    if (!url.startsWith('file:')) return original.getPackageType!(url)
    const manifest = find(scope(url).manifests, url)
    return manifest === kDefer ? original.getPackageType!(url) : manifest?.[2]
  }

  const getNearestParentPackageJSONFromReader = (checkPath: string) => {
    const manifest = find(nearest(checkPath))
    if (manifest === kDefer) return original.reader(checkPath)
    if (manifest) return deserialize(manifest)
    if (absent) return { data: { __proto__: null, type: 'none' }, exists: false, path: checkPath }
  }

  /**
   * Call the native `_load` with `key`, whose resolution from `parentURL` a
   * resolve hook answers with the result of the first resolution, so that
   * hooks run once and `format` is kept.
   */
  const loadAs = function (this: unknown, key: string, result: Resolution, parent: Module | undefined, isMain: boolean | undefined, args: unknown[]) {
    const { url, format, parentURL } = result
    const hook: ResolveHook = {
      resolve: (specifier, context, next) => specifier === key && context.parentURL === parentURL
        ? { url, format, shortCircuit: true }
        : next(specifier, context),
    }
    resolveHooks!.push(hook)
    try {
      return original.load.call(this, key, parent, isMain, ...args)
    } finally {
      const index = resolveHooks!.lastIndexOf(hook)
      if (index !== -1) resolveHooks!.splice(index, 1)
    }
  }

  /** Call the native `_load` with `key`, which `Module._resolveFilename` resolves to `filename` meanwhile. */
  const loadAsFile = function (this: unknown, key: string, filename: string, parent: Module, isMain: boolean | undefined, args: unknown[]) {
    const resolveFilename = (Module as any)._resolveFilename
    let active = true
    const replacement = function (this: unknown, request: string, ...rest: unknown[]) {
      return active && request === key ? filename : resolveFilename.call(this, request, ...rest)
    }
    ;(Module as any)._resolveFilename = replacement
    try {
      return original.load.call(this, key, parent, isMain, ...args)
    } finally {
      active = false
      // a replacement installed meanwhile may call this one, which then forwards every request
      if ((Module as any)._resolveFilename === replacement) (Module as any)._resolveFilename = resolveFilename
    }
  }

  /**
   * Run `load` while `parent.path` reads as `\0<path>` once. The native
   * `_load` reads it first, to key the request cache, so the lookup and the
   * record of the request fall under a key that no request before the
   * installation has been recorded under.
   */
  const inBucket = <T>(parent: Module, load: () => T) => {
    const descriptor = Object.getOwnPropertyDescriptor(parent, 'path')
    if (!descriptor?.configurable || !('value' in descriptor)) return load()
    let restored = false
    const restore = () => {
      if (restored) return
      restored = true
      Object.defineProperty(parent, 'path', descriptor)
    }
    Object.defineProperty(parent, 'path', { configurable: true, get: () => (restore(), `\0${descriptor.value}`) })
    try {
      return load()
    } finally {
      restore()
    }
  }

  // Node's private request cache maps a parent and a request to a file while
  // the file is loaded. Before the first invalidation, a hook may have
  // resolved any request to any file, so the native `_load` receives a
  // request with the parent only under a key derived from its resolution,
  // which no request has been recorded under, and which always resolves to
  // the same file. A resolution error propagates, as it would from the
  // native `_load` on a cache miss.
  const load: Load = function (this: unknown, request, parent, isMain, ...args) {
    if (!parent) return original.load.call(this, request, parent, isMain, ...args)
    const result: Resolution = resolveForCJSWithHooks
      ? resolveForCJSWithHooks(request, parent, isMain, args[0] ?? {})
      : { filename: (Module as any)._resolveFilename(request, parent, isMain) }
    // a URL is reported by hooks and for `node:` requests
    const target = result.url ?? result.filename
    const hooked = !!resolveHooks?.length
    const builtin = isBuiltin(target) ? target.replace(/^node:/, '') : undefined
    // The native `_load` loads a `node:` request for a builtin before it looks
    // up `Module._cache`, and a builtin that requires the scheme only for such
    // a request. It is kept as the request, under a parent path that only
    // these requests are recorded under, always for the builtin.
    if (builtin !== undefined && target.startsWith('node:') && (request === target || !isBuiltin(builtin))) {
      return inBucket(parent, () => hooked
        ? loadAs.call(this, target, result, parent, isMain, args)
        : original.load.call(this, target, parent, isMain, ...args))
    }
    const key = `\0${target}`
    return hooked
      ? loadAs.call(this, key, result, parent, isMain, args)
      : loadAsFile.call(this, key, builtin ?? result.filename, parent, isMain, args)
  }

  const restores: (() => void)[] = []
  try {
    install(restores, binding, 'readPackageJSON', readPackageJSON)
    if (original.getNearestParentPackageJSON) install(restores, binding, 'getNearestParentPackageJSON', getNearestParentPackageJSON)
    install(restores, binding, 'getPackageScopeConfig', getPackageScopeConfig)
    if (original.getPackageType) install(restores, binding, 'getPackageType', getPackageType)
    install(restores, reader, 'getNearestParentPackageJSON', getNearestParentPackageJSONFromReader)
    install(restores, Module as any, '_load', load)
  } catch {
    for (const restore of restores.reverse()) restore()
    return
  }
  return state
}

/** Whether `manifest`, or the manifest at the real path of its directory, is one of the paths or lies below one. */
function isInvalidated(state: ManifestState, manifest: string) {
  if (within(state, manifest)) return true
  const directory = dirname(manifest)
  let real = state.directories.get(directory)
  if (real === undefined) {
    try {
      real = realpathSync(directory)
    } catch {
      real = directory
    }
    state.directories.set(directory, real)
  }
  return real !== directory && within(state, join(real, basename(manifest)))
}

function within(state: ManifestState, path: string) {
  while (true) {
    if (state.paths.has(path)) return true
    const parent = dirname(path)
    if (parent === path) return false
    path = parent
  }
}

/** The manifests that Node's nearest-manifest lookup from `checkPath` visits. */
function nearest(checkPath: string) {
  const manifests: string[] = []
  let directory = checkPath.endsWith(sep) ? checkPath.slice(0, -1) : dirname(checkPath)
  while (dirname(directory) !== directory && basename(directory) !== 'node_modules') {
    manifests.push(join(directory, 'package.json'))
    directory = dirname(directory)
  }
  return manifests
}

/** The manifests that Node's package scope lookup from `url` visits, and the path it reports if none exists. */
function scope(url: string) {
  const manifests: string[] = []
  let current = new URL('./package.json', url)
  while (!current.pathname.endsWith('/node_modules/package.json')) {
    manifests.push(fileURLToPath(current))
    const next = new URL('../package.json', current)
    if (next.pathname === current.pathname) break
    current = next
  }
  return { manifests, last: fileURLToPath(current) }
}

interface ErrorContext {
  base?: string
  specifier?: string
}

function read(state: ManifestState, path: string, context?: ErrorContext) {
  const cached = state.cache.get(path)
  if (cached !== undefined) return cached ?? undefined
  const manifest = parseManifest(path, context)
  state.cache.set(path, manifest ?? null)
  return manifest
}

/** Parse a manifest as Node's native reader does. */
function parseManifest(path: string, context?: ErrorContext): Manifest | undefined {
  let buffer: Buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return
  }
  const fail = (): never => {
    let message = `Invalid package config ${toNamespacedPath(path)}`
    if (context?.base !== undefined) {
      const base = context.base.startsWith('file:') ? fileURLToPath(context.base) : context.base
      message += ` while importing "${context.specifier}" from ${base}`
    }
    throw Object.assign(new Error(message + '.'), { code: 'ERR_INVALID_PACKAGE_CONFIG' })
  }
  if (!isUtf8(buffer)) fail()
  let text = buffer.toString('utf8')
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    fail()
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) fail()
  const isString = (value: unknown): value is string => typeof value === 'string' && value.isWellFormed()
  if ('name' in json && !isString(json.name)) fail()
  if ('type' in json && !isString(json.type)) fail()
  // an object or an array is passed on as its JSON text
  const field = (value: unknown) => {
    if (typeof value === 'string') return isString(value) ? value : fail()
    if (value && typeof value === 'object') return JSON.stringify(value)
  }
  return [
    json.name,
    isString(json.main) ? json.main : undefined,
    json.type === 'commonjs' || json.type === 'module' ? json.type : 'none',
    field(json.imports),
    field(json.exports),
    toNamespacedPath(path),
  ]
}

/** Deserialize a manifest as the reader does. */
function deserialize([name, main, type, imports, exports, path]: Manifest): PackageJSON {
  const parse = (value?: string) => value?.[0] === '[' || value?.[0] === '{' ? JSON.parse(value) : value
  return {
    data: {
      __proto__: null,
      ...name !== undefined && { name },
      ...main !== undefined && { main },
      type,
      exports: parse(exports),
      imports: parse(imports),
    },
    exists: true,
    path,
  }
}
