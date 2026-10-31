import { Dirent, realpath as realpathCallback } from 'node:fs'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'

/**
 * The real path as Node resolves modules. Node's module resolution uses the
 * implementation of `fs.realpath` that resolves the links along the path one
 * by one and keeps the rest of the path as given. `fs.promises.realpath` uses
 * the libuv implementation, which on Windows also expands 8.3 short names and
 * normalizes the case, so that its result can differ from module URLs.
 */
export const realpath: (path: string) => Promise<string> = promisify(realpathCallback)

/** A package installed at a location. */
export interface PackageState {
  /** the name in the installed manifest, which differs from the directory name for an alias */
  name: string
  version?: string
  /** An identifier of the content. Two states with equal resolutions have equal contents. */
  resolution: string
  /**
   * Whether the install state does not record the content, as for a `file:`,
   * `link:`, `portal:` or workspace dependency, a package bundled in one, and
   * a yarn classic package whose version has several sources.
   */
  local: boolean
  /**
   * The real directory of the location when the state was read, as Node
   * resolves modules. It differs from the location for a link at the location
   * or at an ancestor, and a removed link keeps its last target.
   */
  realPath: string
}

export type InstallState = Map<string, PackageState>

async function readText(path: string) {
  try {
    return await readFile(path, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return
    throw error
  }
}

async function readName(dir: string): Promise<string | undefined> {
  const text = await readText(resolve(dir, 'package.json'))
  if (!text) return
  try {
    const { name } = JSON.parse(text)
    return typeof name === 'string' ? name : undefined
  } catch {}
}

async function createLocator(root: string) {
  const realRoot = await realpath(root).catch(() => resolve(root))
  const parents = new Map<string, Promise<string>>()
  return async (location: string, local: boolean) => {
    const path = resolve(root, location)
    const fallback = resolve(realRoot, location)
    if (local) return realpath(path).catch(() => fallback)
    const parent = dirname(path)
    let real = parents.get(parent)
    if (!real) parents.set(parent, real = realpath(parent).catch(() => dirname(fallback)))
    return join(await real, basename(path))
  }
}

export function splitName(spec: string): [string, string] {
  const index = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  if (index <= 0) return [spec, '']
  return [spec.slice(0, index), spec.slice(index + 1)]
}

export function nameOf(location: string) {
  const index = location.lastIndexOf('node_modules/')
  return index < 0 ? location : location.slice(index + 'node_modules/'.length)
}

export async function readNpmState(root: string): Promise<InstallState> {
  const state: InstallState = new Map()
  const text = await readText(resolve(root, 'node_modules/.package-lock.json'))
  if (!text) return state
  const packages: Record<string, any> = JSON.parse(text).packages ?? {}
  const locate = await createLocator(root)

  // A bundled entry records only its version, since its content is that of
  // the tarball of its bundler, i.e. the nearest enclosing package that is
  // not bundled itself.
  const identify = (location: string): Pick<PackageState, 'resolution' | 'local'> => {
    const entry = packages[location]
    const own = entry.integrity ?? entry.resolved ?? `${entry.name ?? nameOf(location)}@${entry.version}`
    const local = !entry.integrity && !!entry.resolved?.startsWith('file:')
    const index = location.lastIndexOf('/node_modules/')
    if (!entry.inBundle || index < 0) return { resolution: own, local }
    const bundler = location.slice(0, index)
    // a workspace or the target of a link
    if (!bundler.includes('node_modules/') || !packages[bundler]) return { resolution: own, local: true }
    const outer = identify(bundler)
    return { resolution: `${own} ${outer.resolution}`, local: local || outer.local }
  }

  for (const [location, entry] of Object.entries(packages)) {
    if (!location.includes('node_modules/')) continue
    if (entry.link) {
      // the name is recorded by the target entry, if it differs from the directory name
      const name = packages[entry.resolved]?.name ?? await readName(resolve(root, entry.resolved)) ?? nameOf(location)
      state.set(location, { name, resolution: `link:${entry.resolved}`, local: true, realPath: await locate(location, true) })
      continue
    }
    const identity = identify(location)
    const realPath = await locate(location, identity.local)
    state.set(location, { name: entry.name ?? nameOf(location), version: entry.version, ...identity, realPath })
  }
  return state
}

export async function readPnpmState(root: string): Promise<InstallState> {
  const state: InstallState = new Map()
  const [modulesText, lockText] = await Promise.all([
    readText(resolve(root, 'node_modules/.modules.yaml')),
    readText(resolve(root, 'node_modules/.pnpm/lock.yaml')),
  ])
  if (!modulesText) return state
  const modules = parse(modulesText) ?? {}
  const lock = lockText ? parse(lockText) ?? {} : {}
  const packages: Record<string, any> = lock.packages ?? {}
  const locate = await createLocator(root)

  for (const [depPath, locations] of Object.entries<string[]>(modules.hoistedLocations ?? {})) {
    // a peer suffix, e.g. `react-dom@18.0.0(react@18.0.0)`, is not part of the package key
    const key = depPath.replace(/\(.*$/, '')
    const [name, version] = splitName(key)
    const resolution = packages[key]?.resolution
    const local = resolution?.type === 'directory' || /^(file|link):/.test(version)
    for (const location of locations) {
      state.set(location, {
        name,
        version: version.includes(':') ? undefined : version,
        resolution: `${depPath} ${JSON.stringify(resolution ?? null)}`,
        local,
        realPath: await locate(location, local),
      })
    }
  }

  for (const [importer, data] of Object.entries<any>(lock.importers ?? {})) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, dep] of Object.entries<any>(data?.[field] ?? {})) {
        const version: string | undefined = dep?.version
        if (!version?.startsWith('link:')) continue
        const location = posix.join(importer, 'node_modules', name)
        const target = resolve(root, importer, version.slice(5))
        const realPath = await locate(location, true)
        state.set(location, { name: await readName(target) ?? name, resolution: version, local: true, realPath })
      }
    }
  }
  return state
}

export async function readYarnBerryState(root: string): Promise<InstallState> {
  const state: InstallState = new Map()
  const text = await readText(resolve(root, 'node_modules/.yarn-state.yml'))
  if (!text) return state
  const data: Record<string, any> = parse(text) ?? {}
  const locate = await createLocator(root)
  for (const [locator, entry] of Object.entries(data)) {
    if (locator === '__metadata') continue
    const [ident, raw] = splitName(locator)
    // a package with peer dependencies, e.g. `virtual:<hash>#workspace:packages/foo`
    const reference = raw.replace(/^virtual:[^#]*#/, '')
    const local = /^(workspace|file|link|portal):/.test(reference)
    const version = reference.startsWith('npm:') ? reference.slice(4).split('::')[0] : undefined
    for (const location of entry?.locations ?? []) {
      // the root workspace
      if (!location) continue
      // the ident of a local package is that of its dependency, which may be an alias
      const name = local ? await readName(resolve(root, location)) ?? ident : ident
      state.set(location, { name, version, resolution: locator, local, realPath: await locate(location, local) })
    }
  }
  return state
}

/**
 * A string of a yarn classic lockfile. Yarn quotes a string that contains
 * whitespace, a comma, a colon, a quote, a bracket or a backslash with
 * `JSON.stringify()`, so that an unquoted string contains none of them.
 */
const YARN_CLASSIC_LOCKFILE_STRING = /"(?:[^"\\]|\\.)*"|[^\s",:[\]\\]+/g

function unquote(value: string) {
  if (!value.startsWith('"')) return value
  try {
    return JSON.parse(value) as string
  } catch {
    // a pattern that cannot be read is not found, so that its version is unknown
    return value
  }
}

function parseYarnLockVersions(text: string) {
  const versions = new Map<string, string>()
  let patterns: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    if (!/^\s/.test(line)) {
      patterns = (line.match(YARN_CLASSIC_LOCKFILE_STRING) ?? []).map(unquote)
      continue
    }
    const capture = /^ {2}version (.+)$/.exec(line)
    if (capture) for (const pattern of patterns) versions.set(pattern, unquote(capture[1].trim()))
  }
  return versions
}

export async function readYarnClassicState(root: string): Promise<InstallState> {
  const state: InstallState = new Map()
  const [text, lockText] = await Promise.all([
    readText(resolve(root, 'node_modules/.yarn-integrity')),
    readText(resolve(root, 'yarn.lock')),
  ])
  if (!text) return state
  const integrity = JSON.parse(text)
  const versions = parseYarnLockVersions(lockText ?? '')
  const locate = await createLocator(root)

  // name → version → sources, where an unknown version is `undefined`
  const resolved = new Map<string, Map<string | undefined, Set<string>>>()
  const localNames = new Set<string>(integrity.linkedModules ?? [])
  for (const [pattern, url] of Object.entries<string>(integrity.lockfileEntries ?? {})) {
    const [name, range] = splitName(pattern)
    if (!url || /^(file|link):/.test(range)) localNames.add(name)
    if (!resolved.has(name)) resolved.set(name, new Map())
    const byVersion = resolved.get(name)!
    const version = versions.get(pattern)
    if (!byVersion.has(version)) byVersion.set(version, new Set())
    byVersion.get(version)!.add(url)
  }

  /** the package that a bundled package comes with, by the name of the latter */
  type Bundler = (name: string) => Pick<PackageState, 'resolution' | 'local'> | undefined

  const visit = async (location: string, dirent: Dirent, bundler: Bundler) => {
    const dir = resolve(root, location)
    const manifestText = await readText(resolve(dir, 'package.json'))
    if (!manifestText) return
    const manifest = JSON.parse(manifestText)
    const key = nameOf(location)
    if (dirent.isSymbolicLink()) {
      const realPath = await locate(location, true)
      state.set(location, { name: manifest.name ?? key, resolution: `link:${await readlink(dir)}`, local: true, realPath })
      return
    }
    // A bundled package is not resolved from the lockfile, whose entries of
    // the same name describe other copies. Its content is that of its bundler.
    let identity: Pick<PackageState, 'resolution' | 'local'>
    const outer = bundler(key)
    if (outer) {
      identity = { resolution: `${key}@${manifest.version} ${outer.resolution}`, local: outer.local }
    } else {
      const byVersion = resolved.get(key)
      const sources = [...new Set([...byVersion?.get(manifest.version) ?? [], ...byVersion?.get(undefined) ?? []])].sort()
      // The install state does not record which of several sources of a
      // version is installed at a location, so that its content is unknown.
      identity = { resolution: [manifest.version, ...sources].join(' '), local: localNames.has(key) || sources.length > 1 }
    }
    state.set(location, {
      name: manifest.name ?? key,
      version: manifest.version,
      ...identity,
      realPath: await locate(location, identity.local),
    })
    // Every package below a bundled one comes with the same bundler.
    const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies
    await walk(posix.join(location, 'node_modules'), outer
      ? () => outer
      : name => bundled === true || Array.isArray(bundled) && bundled.includes(name) ? identity : undefined)
  }

  const walk = async (folder: string, bundler: Bundler = () => undefined) => {
    let dirents: Dirent[]
    try {
      dirents = await readdir(resolve(root, folder), { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(dirents.map(async (dirent) => {
      if (dirent.name.startsWith('.')) return
      const location = posix.join(folder, dirent.name)
      if (!dirent.name.startsWith('@')) return visit(location, dirent, bundler)
      const scoped = await readdir(resolve(root, location), { withFileTypes: true }).catch(() => [])
      await Promise.all(scoped.map(dirent => visit(posix.join(location, dirent.name), dirent, bundler)))
    }))
  }

  const folders = new Set<string>(integrity.modulesFolders ?? ['node_modules'])
  await Promise.all([...folders].map(folder => walk(folder.replace(/\\/g, '/'))))
  return state
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
