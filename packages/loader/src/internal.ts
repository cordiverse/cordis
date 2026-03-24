import { createRequire, LoadHookContext } from 'node:module'
import { Dict } from 'cosmokit'

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
interface LoadCache extends Omit<Map<string, Dict<LoadCacheData>>, 'get' | 'set' | 'has'> {
  get(url: string, type?: string): LoadCacheData | undefined
  set(url: string, type?: string, job?: LoadCacheData): this
  has(url: string, type?: string): boolean
}

export interface ModuleWrap {
  url: string
  getNamespace(): any
}

/** @see https://github.com/nodejs/node/blob/main/lib/internal/modules/esm/module_job.js */
export interface ModuleJob {
  url: string
  loader: ModuleLoader
  module?: ModuleWrap
  importAttributes: ImportAttributes
  linked: Promise<ModuleJob[]>
  instantiate(): Promise<void>
  run(): Promise<{ module: ModuleWrap }>
}

/**
 * Node 22/23 ModuleLoader interface.
 *
 * Key methods:
 * - getModuleJobForImport(specifier, parentURL, importAttributes)
 * - resolve(specifier, parentURL, importAttributes) → Promise<ResolveResult>
 * - resolveSync(specifier, parentURL, importAttributes) → ResolveResult
 */
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
 * Node 24+ ModuleLoader interface.
 *
 * Breaking changes from v1:
 * - getModuleJobForImport removed → getOrCreateModuleJob(parentURL, request, requestType)
 * - resolve removed (became private #resolve) → resolveSync(parentURL, request)
 * - Parameter order reversed for resolveSync, request object { specifier, attributes }
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

export namespace ModuleLoader {
  let _cachedLoader: ModuleLoader | undefined

  export function fromInternal(): ModuleLoader | undefined {
    if (!process.execArgv.includes('--expose-internals')) return
    if (_cachedLoader) return _cachedLoader
    const require = createRequire(import.meta.url)
    const [major] = process.versions.node.split('.').map(Number)

    if (major >= 24) {
      const raw = require('internal/modules/esm/loader').getOrInitializeCascadedLoader()
      return _cachedLoader = Object.assign(raw, { version: 'v2' })
    } else if (major >= 22) {
      const raw = require('internal/modules/esm/loader').getOrInitializeCascadedLoader()
      return _cachedLoader = Object.assign(raw, { version: 'v1' })
    }
  }
}
