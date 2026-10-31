import { Dirent } from 'node:fs'
import { readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import { parse } from 'yaml'

/** A package installed at a location. */
export interface PackageState {
  /** the name in the installed manifest, which differs from the directory name for an alias */
  name: string
  version?: string
  /** An identifier of the content. Two states with equal resolutions have equal contents. */
  resolution: string
  /**
   * Whether the install state does not record the content, as for a `file:`,
   * `link:`, `portal:` or workspace dependency and a package bundled in one.
   */
  local: boolean
  /**
   * The real directory of the location when the state was read. It differs
   * from the location for a link, and a removed link keeps its last target.
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
  return async (location: string, local: boolean) => {
    if (!local) return resolve(realRoot, location)
    return realpath(resolve(root, location)).catch(() => resolve(realRoot, location))
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

export async function readYarnClassicState(root: string): Promise<InstallState> {
  const state: InstallState = new Map()
  const text = await readText(resolve(root, 'node_modules/.yarn-integrity'))
  if (!text) return state
  const integrity = JSON.parse(text)
  const locate = await createLocator(root)

  const resolved = new Map<string, Set<string>>()
  const localNames = new Set<string>(integrity.linkedModules ?? [])
  for (const [pattern, url] of Object.entries<string>(integrity.lockfileEntries ?? {})) {
    const [name, range] = splitName(pattern)
    if (!url || /^(file|link):/.test(range)) localNames.add(name)
    if (!resolved.has(name)) resolved.set(name, new Set())
    resolved.get(name)!.add(url)
  }

  const visit = async (location: string, dirent: Dirent) => {
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
    const urls = [...resolved.get(key) ?? []].sort()
    const matched = urls.filter(url => url.split('#')[0].endsWith(`-${manifest.version}.tgz`))
    const local = localNames.has(key)
    state.set(location, {
      name: manifest.name ?? key,
      version: manifest.version,
      resolution: [manifest.version, ...matched.length ? matched : urls].join(' '),
      local,
      realPath: await locate(location, local),
    })
    await walk(posix.join(location, 'node_modules'))
  }

  const walk = async (folder: string) => {
    let dirents: Dirent[]
    try {
      dirents = await readdir(resolve(root, folder), { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(dirents.map(async (dirent) => {
      if (dirent.name.startsWith('.')) return
      const location = posix.join(folder, dirent.name)
      if (!dirent.name.startsWith('@')) return visit(location, dirent)
      const scoped = await readdir(resolve(root, location), { withFileTypes: true }).catch(() => [])
      await Promise.all(scoped.map(dirent => visit(posix.join(location, dirent.name), dirent)))
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
    }
  }
  return diff
}
