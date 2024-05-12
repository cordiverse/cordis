import { LoadHookContext } from 'module'
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

interface LoadCache extends Omit<Map<string, Dict<ModuleJob | Function>>, 'get' | 'set' | 'has'> {
  get(url: string, type?: string): ModuleJob | Function | undefined
  set(url: string, type?: string, job?: ModuleJob | Function): this
  has(url: string, type?: string): boolean
}

export interface ModuleWrap {
  url: string
  getNamespace(): any
}

export interface ModuleJob {
  url: string
  loader: ModuleLoader
  module?: ModuleWrap
  importAttributes: ImportAttributes
  linked: Promise<ModuleJob[]>
  instantiate(): Promise<void>
  run(): Promise<{ module: ModuleWrap }>
}

export interface ModuleLoader {
  loadCache: LoadCache
  import(specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<any>
  register(specifier: string | URL, parentURL?: string | URL, data?: any, transferList?: any[]): void
  getModuleJob(specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<ModuleJob>
  getModuleJobSync(specifier: string, parentURL: string, importAttributes: ImportAttributes): ModuleJob
  resolve(originalSpecifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<ResolveResult>
  resolveSync(originalSpecifier: string, parentURL: string, importAttributes: ImportAttributes): ResolveResult
  load(specifier: string, context: Pick<LoadHookContext, 'format' | 'importAttributes'>): Promise<LoadResult>
  loadSync(specifier: string, context: Pick<LoadHookContext, 'format' | 'importAttributes'>): LoadResult
}
