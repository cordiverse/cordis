import { createRequire, LoadHookContext } from 'node:module'
import { Dict } from 'cosmokit'

type ModuleFormat = 'builtin' | 'commonjs' | 'json' | 'module' | 'wasm'
type ModuleSource = string | ArrayBuffer

interface ResolveResult {
  format: ModuleFormat
  url: string
}

interface LoadResult {
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

/** @see https://github.com/nodejs/node/blob/main/lib/internal/modules/esm/loader.js */
export interface ModuleLoader {
  loadCache: LoadCache
  import(specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<any>
  register(specifier: string | URL, parentURL?: string | URL, data?: any, transferList?: any[]): void
  getModuleJobForImport(specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<ModuleJob>
  resolve(originalSpecifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<ResolveResult>
  resolveSync(originalSpecifier: string, parentURL: string, importAttributes: ImportAttributes): ResolveResult
  load(specifier: string, context: Pick<LoadHookContext, 'format' | 'importAttributes'>): Promise<LoadResult>
}

export namespace ModuleLoader {
  const internalLoaders: ((require: NodeJS.Require) => any)[] = [
    // Node 20.13 and above
    (require) => require('internal/modules/esm/loader').getOrInitializeCascadedLoader(),
    (require) => require('internal/process/esm_loader').esmLoader,
  ]

  export function fromInternal() {
    if (!process.execArgv.includes('--expose-internals')) return
    const require = createRequire(import.meta.url)
    for (const loader of internalLoaders) {
      try {
        return loader(require)
      } catch {}
    }
  }
}
