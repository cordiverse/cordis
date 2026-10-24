import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The `package.json` layer of the module cache.
//
// Node reads a manifest through a native cache that cannot be cleared, so
// after a package update every lookup that consults one — the entry of a bare
// specifier, the type of a `.js` file — keeps answering with the old manifest.
// The caches cannot be cleared, so the lookups stop being asked: for a package
// directory that has been invalidated, the manifest is read from disk and the
// entry is resolved here, and a resolve hook hands Node the fresh path in
// place of the stale one.

const require = createRequire(import.meta.url)
const Module = require('node:module')

export interface Manifest {
  name?: string
  main?: string
  type?: string
  exports?: unknown
}

// package directories whose manifest changed since the process last read it
const invalidated = new Set<string>()
let installed = false

function toPath(url: string) {
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

/** The manifest of a package directory, read from disk. */
export function read(packageDir: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Mark a package directory as updated: its lookups stop asking Node. A URL
 * that holds no manifest is not a package directory and is ignored.
 */
export function invalidate(url: string) {
  const dir = toPath(url)
  if (!dir || !existsSync(join(dir, 'package.json'))) return
  if (invalidated.has(dir)) return
  invalidated.add(dir)
  // The loader reports a package by its real path — Node resolves the links
  // on the way to it — so a directory reached through one is also recorded
  // that way. macOS reaches its temporary directory through `/var`, and a
  // symlinked package layout is the same shape.
  const real = realpathSync(dir)
  if (real !== dir) invalidated.add(real)
  install()
}

/** Whether the lookups of a package directory already bypass Node. */
export function isInvalidated(url: string) {
  const dir = toPath(url)
  return !!dir && invalidated.has(dir)
}

/**
 * Resolve a subpath of a package directory to an absolute file path, the way
 * `exports` and `main` describe it. The subset a reload can meet is covered:
 * the conditions `node`, `import`, `require` and `default`, one `*` wildcard
 * per pattern, and `main` as the fallback for the entry itself.
 */
export function resolveEntry(packageDir: string, subpath: string, format?: string): string | undefined {
  const manifest = read(packageDir)
  if (!manifest) return undefined
  const conditions = format === 'commonjs'
    ? ['node', 'require', 'default']
    : ['node', 'import', 'default']
  const target = manifest.exports !== undefined
    ? resolveExports(manifest.exports, subpath, conditions)
    : subpath === '.' ? manifest.main : undefined
  return target ? join(packageDir, target) : undefined
}

function resolveExports(exports: unknown, subpath: string, conditions: string[]): string | undefined {
  if (typeof exports === 'string') return exports
  if (Array.isArray(exports)) {
    for (const item of exports) {
      const target = resolveExports(item, subpath, conditions)
      if (target) return target
    }
    return undefined
  }
  if (!exports || typeof exports !== 'object') return undefined
  for (const [key, value] of Object.entries(exports)) {
    if (key.startsWith('.')) {
      if (key === '.') {
        if (subpath !== '.') continue
        const target = resolveExports(value, '.', conditions)
        if (target) return target
      } else if (key.endsWith('/*')) {
        const prefix = key.slice(0, -1)
        if (!subpath.startsWith(prefix) || subpath.length === prefix.length) continue
        const capture = subpath.slice(prefix.length)
        const target = resolveExports(value, './*', conditions)
        if (target) return target.replace('*', capture)
      } else if (key === subpath) {
        const target = resolveExports(value, subpath, conditions)
        if (target) return target
      }
    } else if (conditions.includes(key)) {
      const target = resolveExports(value, subpath, conditions)
      if (target) return target
    }
  }
  return undefined
}

// One hook covers every lookup the process makes afterwards, the ones inside
// a re-imported module included, and on both sides: `registerHooks` answers
// for `require` as well as for `import`, so the CJS path cache and the reader
// behind it are bypassed by the same answer. It is installed on the first
// invalidation and costs one set lookup per resolution until then.
// the fresh entry for a lookup, or undefined when the answer stands. `format`
// picks the `import` / `require` condition of `exports`, so the answer follows
// the side the lookup came from.
function fresh(request: string, path: string, format?: string) {
  const dir = owner(path)
  if (!dir) return undefined
  const subpath = subpathOf(request, read(dir)?.name)
  if (subpath === undefined) return undefined
  const target = resolveEntry(dir, subpath, format)
  if (!target || target === path) return undefined
  return target
}

function install() {
  if (installed) return
  installed = true
  if (typeof Module.registerHooks === 'function') {
    Module.registerHooks({
      resolve(specifier: string, context: any, nextResolve: any) {
        const result = nextResolve(specifier, context)
        const path = result?.url && toPath(result.url)
        const target = path && fresh(specifier, path, result.format)
        if (!target) return result
        return { url: pathToFileURL(target).href }
      },
      // Node decides a module's format while it loads it, from the manifest it
      // reads there, so a flipped `type` reaches the loader only if the format
      // is handed over. Outside an invalidated package the answer stands.
      load(url: string, context: any, nextLoad: any) {
        const path = toPath(url)
        const dir = path && owner(path)
        if (!dir) return nextLoad(url, context)
        const format = formatOf(dir, path)
        if (!format || format === context.format) return nextLoad(url, context)
        return nextLoad(url, { ...context, format })
      },
    })
  }
  // `require` resolves through `Module._resolveFilename`, and the hook above
  // does not answer for it on every platform (measured on the matrix), so the
  // CJS side is served where it resolves. A lookup outside an invalidated
  // package returns the original answer untouched.
  const resolve = Module._resolveFilename
  if (typeof resolve !== 'function') return
  Module._resolveFilename = function (request: string, ...rest: any[]) {
    const filename = resolve.call(this, request, ...rest)
    if (typeof filename !== 'string') return filename
    return fresh(request, filename, 'commonjs') ?? filename
  }
}

// The type the manifest on disk describes for a `.js` file, found by walking
// up to the package root. Only `.js` reads a type; every other extension
// carries its own format.
function formatOf(packageDir: string, target: string) {
  if (!target.endsWith('.js') || target.endsWith('.mjs') || target.endsWith('.cjs')) return undefined
  let dir = dirname(target)
  while (dir.startsWith(packageDir)) {
    const type = read(dir)?.type
    if (type) return type === 'module' ? 'module' : 'commonjs'
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'commonjs'
}

// the invalidated package a resolved path belongs to
function owner(path: string) {
  for (const dir of invalidated) {
    if (path === dir || path.startsWith(dir + sep)) return dir
  }
  return undefined
}

// the subpath a specifier addresses inside its package: `p` → `.`, `p/x` →
// `./x`, and undefined for anything else, such as a relative path
function subpathOf(specifier: string, name: string | undefined) {
  if (!name) return undefined
  if (specifier === name) return '.'
  if (specifier.startsWith(name + '/')) return './' + specifier.slice(name.length + 1)
  return undefined
}
