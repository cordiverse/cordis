import { createRequire } from 'node:module'

/** Node's internal ESM loader, of which the loader only imports modules. */
export interface InternalLoader {
  import(specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<any>
}

/** The outcome of one lookup: the loader, or one line per route that failed to reach it. */
export interface InternalLookup {
  loader?: InternalLoader
  /** Absent when `loader` is present. */
  reason?: string
}

/** The first line of an error: `MODULE_NOT_FOUND` appends a require stack that names this file. */
function detail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0]
}

/**
 * Look for Node's internal ESM loader, through `--expose-internals` or
 * `node-addon-require-builtin`, and report why each route failed.
 *
 * The routes are parameters so that both outcomes can be reached in a test: a
 * process either has `--expose-internals` or it does not, and a test that waits for
 * one of them to happen by itself can only assert the branch it landed in.
 *
 * Nothing is remembered between calls. A module-level slot would make the answer
 * depend on which `Loader` was constructed last, and the reason would then be
 * reported against the wrong one.
 */
export function findInternalLoader(
  require: (id: string) => any = createRequire(import.meta.url),
  argv: string[] = process.execArgv,
): InternalLookup {
  const failures: string[] = []
  const id = 'internal/modules/esm/loader'
  let internal: any
  // Node accepts either spelling on the command line, and `process.execArgv`
  // keeps the one that was typed; a check for one spelling misses a process
  // started with the other and then blames the addon for it.
  const spelled = (flag: string) => argv.some((arg) => arg.replace(/_/g, '-') === flag)
  if (spelled('--expose-internals')) {
    try {
      internal = require(id)
    } catch (error) {
      failures.push(`require(${JSON.stringify(id)}) with --expose-internals: ${detail(error)}`)
    }
  } else {
    failures.push('--expose-internals is not among the process arguments')
  }
  if (!internal) {
    try {
      internal = require('node-addon-require-builtin').requireBuiltin(id)
    } catch (error) {
      failures.push(`node-addon-require-builtin: ${detail(error)}`)
    }
  }
  const loader = internal?.getOrInitializeCascadedLoader?.()
  if (typeof loader?.import === 'function') return { loader }
  if (internal) failures.push(`${id} has no getOrInitializeCascadedLoader() returning import()`)
  return { reason: failures.join('; ') }
}

/** Get the component exported by a module namespace. */
export function unwrapExports(exports: any) {
  if (exports === null || exports === undefined) return exports
  exports = exports.default ?? exports
  // a module compiled to CommonJS keeps its exports under `default`
  if (typeof exports !== 'object' || exports.__esModule) return exports
  return exports.default ?? exports
}
