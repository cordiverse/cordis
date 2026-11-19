import { createRequire, LoadHookContext } from 'node:module'

export type ModuleFormat = 'builtin' | 'commonjs' | 'json' | 'module' | 'wasm'
export type ModuleSource = string | ArrayBuffer

export interface ResolveResult {
  format: ModuleFormat
  url: string
}

export interface LoadResult {
  format: ModuleFormat
  source?: ModuleSource
}

type LoadCacheData = ModuleJob // | Function

/** @see https://github.com/nodejs/node/blob/main/lib/internal/modules/esm/module_map.js */
interface LoadCache extends Omit<Map<string, Record<string, LoadCacheData>>, 'get' | 'set' | 'has'> {
  get(url: string, type?: string): LoadCacheData | undefined
  set(url: string, type?: string, job?: LoadCacheData): this
  has(url: string, type?: string): boolean
}

/**
 * Get the module jobs cached for `url`. An entry of the load cache holds one
 * job per value of the `type` import attribute. `loadCache.get(url)` only
 * reads the `javascript` slot, which an import without the attribute uses,
 * so it misses a job imported `with { type: 'json' }`.
 */
export function getModuleJobs(loadCache: LoadCache, url: string): ModuleJob[] {
  const entry: Record<string, LoadCacheData> | undefined = Map.prototype.get.call(loadCache, url)
  return Object.values(entry ?? {}).filter(Boolean)
}

/** @see https://v8.github.io/api/head/classv8_1_1Module.html */
export const enum ModuleStatus {
  Uninstantiated = 0,
  Instantiating = 1,
  Instantiated = 2,
  Evaluating = 3,
  Evaluated = 4,
  Errored = 5,
}

export interface ModuleWrap {
  url: string
  getNamespace(): any
  getStatus(): ModuleStatus
}

/** @see https://github.com/nodejs/node/blob/main/lib/internal/modules/esm/module_job.js */
export interface ModuleJob {
  url: string
  loader: ModuleLoader
  module?: ModuleWrap
  importAttributes: ImportAttributes
  modulePromise: Promise<ModuleWrap>
  /** a promise on Node 22 and 23, an array on Node 24 and later */
  linked: ModuleJob[] | Promise<ModuleJob[]>
  /** set by the first call to `instantiate()` */
  instantiated?: Promise<void>
  instantiate(): Promise<void>
  run(): Promise<{ module: ModuleWrap }>
}

/** The ModuleLoader of Node before 24.12. */
export interface ModuleLoaderV1 {
  version: 'v1'
  loadCache: LoadCache
  import(specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<any>
  register(specifier: string | URL, parentURL?: string | URL, data?: any, transferList?: any[]): void
  getModuleJobForImport(specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<ModuleJob>
  resolve(specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<ResolveResult>
  resolveSync(specifier: string, parentURL: string, importAttributes: ImportAttributes): ResolveResult
  load(specifier: string, context: Pick<LoadHookContext, 'format' | 'importAttributes'>): Promise<LoadResult>
}

export interface ModuleRequest {
  specifier: string
  attributes?: ImportAttributes
  phase?: ModulePhase
}

/** @see https://github.com/nodejs/node/blob/main/src/module_wrap.h */
export const enum ModulePhase {
  Source = 1,
  Evaluation = 2,
}

export type ModuleRequestType = unknown // internal symbols

/**
 * The ModuleLoader of Node 24.12 and later. Changes from v1:
 * - getModuleJobForImport removed → getOrCreateModuleJob(parentURL, request, requestType)
 * - resolve removed (became private #resolve) → resolveSync(parentURL, request)
 * - Parameter order reversed for resolveSync, request object { specifier, attributes }
 * - `import()` gained `phase` and `isEntryPoint`, `register()` gained `isInternal`
 * - `load()` takes a `url` where v1 took a `specifier`
 * - LoadCache became typed Map<url, { [type]: ModuleJob }> with delete only setting undefined
 */
export interface ModuleLoaderV2 {
  version: 'v2'
  loadCache: LoadCache
  import(specifier: string, parentURL: string, importAttributes: ImportAttributes, phase?: ModulePhase, isEntryPoint?: boolean): Promise<any>
  register(specifier: string | URL, parentURL?: string | URL, data?: any, transferList?: any[], isInternal?: boolean): void
  getOrCreateModuleJob(parentURL: string, request: ModuleRequest, requestType?: ModuleRequestType): Promise<ModuleJob>
  resolveSync(parentURL: string, request: ModuleRequest): ResolveResult
  load(url: string, context: Pick<LoadHookContext, 'format' | 'importAttributes'>): Promise<LoadResult>
}

export type ModuleLoader = ModuleLoaderV1 | ModuleLoaderV2

/**
 * Load an internal module of Node, through `--expose-internals` or
 * `node-addon-require-builtin`.
 * @returns the module, or `undefined` when it is unreachable.
 */
export function requireInternal(id: string): any {
  const require = createRequire(import.meta.url)
  if (process.execArgv.includes('--expose-internals')) {
    try {
      return require(id)
    } catch {}
  }
  try {
    return require('node-addon-require-builtin').requireBuiltin(id)
  } catch {}
}

/**
 * Get an internal binding of Node, through `internal/bootstrap/realm` or,
 * under `--expose-internals` alone, `internal/test/binding`.
 * @returns the binding, or `undefined` when it is unreachable.
 */
export function internalBinding(id: string): any {
  const realm = requireInternal('internal/bootstrap/realm')
  if (realm) return realm.internalBinding(id)
  // `internal/test/binding` warns when it is loaded
  const { emitWarning } = process
  process.emitWarning = function (this: unknown, ...args: any[]) {
    const type = typeof args[1] === 'string' ? args[1] : args[1]?.type
    if (type !== 'internal/test/binding') return emitWarning.apply(this, args as any)
  } as typeof emitWarning
  try {
    return requireInternal('internal/test/binding')?.internalBinding(id)
  } catch {} finally {
    process.emitWarning = emitWarning
  }
}

export namespace ModuleLoader {
  let _cachedLoader: ModuleLoader | undefined

  /**
   * Get the running ESM loader of Node, classified by the module-job API that
   * it owns, since its interface changed within Node 24.
   * @returns the classified loader, or `undefined` when none is reachable or it owns neither API.
   */
  export function fromInternal(): ModuleLoader | undefined {
    if (_cachedLoader) return _cachedLoader
    const [major] = process.versions.node.split('.').map(Number)
    if (major < 22) return

    const raw = requireInternal('internal/modules/esm/loader')?.getOrInitializeCascadedLoader()
    if (!raw) return
    const version = typeof raw.getOrCreateModuleJob === 'function'
      ? 'v2'
      : typeof raw.getModuleJobForImport === 'function' ? 'v1' : undefined
    if (!version) return
    return _cachedLoader = Object.assign(raw, { version })
  }
}
