import { relative, resolve, sep } from 'node:path'

/** A package installed at a location. */
export interface PackageState {
  /** the name in the installed manifest, which differs from the directory name for an alias */
  name: string
  version?: string
  /**
   * An identifier of the content of a package that is not local: two such
   * states with equal resolutions have equal contents. In an isolated layout,
   * it is the real directory of a store entry, whose name identifies the
   * content. The resolution of a local package does not identify its content.
   */
  resolution: string
  /**
   * Whether the install state does not identify the content, so that every
   * installation reports the package as updated. This holds for:
   *
   * - a `file:`, `link:`, `portal:` or workspace dependency, and a package bundled in one;
   * - a yarn classic package whose version has several sources;
   * - in an isolated layout, a package outside the store, a store entry that
   *   the agent updates in place, and a store entry of unknown source.
   */
  local: boolean
  /**
   * The real directory of the location when the state was read, as Node
   * resolves modules. It differs from the location for a link at the location
   * or at an ancestor, and a removed link keeps its last target.
   */
  realPath: string
}

/** The packages of a project by location, i.e. the path relative to the project root with `/` as the separator. */
export type InstallState = Map<string, PackageState>

/** Split a specifier `<name>@<rest>`, whose name may be scoped. */
export function splitName(spec: string): [string, string] {
  const index = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  if (index <= 0) return [spec, '']
  return [spec.slice(0, index), spec.slice(index + 1)]
}

/** the dependency name of a location, i.e. the path below its last `node_modules` folder */
export function nameOf(location: string) {
  const index = location.lastIndexOf('node_modules/')
  return index < 0 ? location : location.slice(index + 'node_modules/'.length)
}

/** The package that a location resolves to in an isolated layout. */
export interface Target {
  name: string
  version?: string
  realPath: string
  local: boolean
}

/**
 * Create an install state of an isolated layout, to which a package is added
 * by its absolute location. The resolution of a package is its real
 * directory, prefixed with `link:` if the package is local.
 */
export function createIsolatedState(realRoot: string) {
  const state: InstallState = new Map()
  const add = (path: string, { name, version, realPath, local }: Target) => {
    const location = relative(realRoot, path).split(sep).join('/')
    state.set(location, { name, version, resolution: local ? `link:${realPath}` : realPath, local, realPath })
  }
  return { state, add }
}

/** A package added, removed or updated at a location. */
export interface PackageChange {
  /** the dependency name, i.e. the directory name under `node_modules` */
  name: string
  /**
   * The location below the real project root. Node resolves dependencies
   * from the real paths of modules, so a dependency name is resolved through
   * this path. A link at the location itself is not resolved.
   */
  path: string
  before?: PackageState
  after?: PackageState
}

export interface StateDiff {
  added: PackageChange[]
  removed: PackageChange[]
  updated: PackageChange[]
}

export function diffState(root: string, before: InstallState, after: InstallState): StateDiff {
  const diff: StateDiff = { added: [], removed: [], updated: [] }
  const locations = [...new Set([...before.keys(), ...after.keys()])].sort()
  for (const location of locations) {
    const change: PackageChange = {
      name: nameOf(location),
      path: resolve(root, location),
      before: before.get(location),
      after: after.get(location),
    }
    if (!change.before) {
      diff.added.push(change)
    } else if (!change.after) {
      diff.removed.push(change)
    } else if (change.after.local || change.before.resolution !== change.after.resolution) {
      diff.updated.push(change)
    } else if (change.before.realPath !== change.after.realPath) {
      // the same content at another real directory, e.g. below a replaced link
      diff.updated.push(change)
    }
  }
  return diff
}
