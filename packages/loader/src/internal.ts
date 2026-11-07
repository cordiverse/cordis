import { createRequire } from 'node:module'

/** Node's internal ESM loader, of which the loader only imports modules. */
export interface InternalLoader {
  import(specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<any>
}

/**
 * Get Node's internal ESM loader, through `--expose-internals` or
 * `node-addon-require-builtin`.
 * @returns the loader, or `undefined` when it is unreachable.
 */
export function getInternalLoader(): InternalLoader | undefined {
  const require = createRequire(import.meta.url)
  const id = 'internal/modules/esm/loader'
  let internal: any
  if (process.execArgv.includes('--expose-internals')) {
    try {
      internal = require(id)
    } catch {}
  }
  if (!internal) {
    try {
      internal = require('node-addon-require-builtin').requireBuiltin(id)
    } catch {}
  }
  const loader = internal?.getOrInitializeCascadedLoader?.()
  if (typeof loader?.import === 'function') return loader
}

/** Get the plugin exported by a module namespace. */
export function unwrapExports(exports: any) {
  if (exports === null || exports === undefined) return exports
  exports = exports.default ?? exports
  // https://github.com/evanw/esbuild/issues/2623
  // https://esbuild.github.io/content-types/#default-interop
  if (!exports.__esModule) return exports
  return exports.default ?? exports
}
