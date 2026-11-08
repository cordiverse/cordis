import { isNullable } from 'cosmokit'

export * from './internal.ts'

/** Get the plugin exported by a module namespace. */
export function unwrapExports(exports: any) {
  if (isNullable(exports)) return exports
  exports = exports.default ?? exports
  // https://github.com/evanw/esbuild/issues/2623
  // https://esbuild.github.io/content-types/#default-interop
  if (!exports.__esModule) return exports
  return exports.default ?? exports
}
