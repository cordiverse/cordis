import { Dirent } from 'node:fs'
import { readdir, readFile, readlink } from 'node:fs/promises'
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
   * A `file:`, `link:`, `portal:` or workspace dependency, whose content is
   * not recorded by the install state.
   */
  local: boolean
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
  for (const [location, entry] of Object.entries(packages)) {
    if (!location.includes('node_modules/')) continue
    const name = entry.name ?? nameOf(location)
    if (entry.link) {
      state.set(location, { name, resolution: `link:${entry.resolved}`, local: true })
      continue
    }
    const local = !entry.integrity && !!entry.resolved?.startsWith('file:')
    state.set(location, {
      name,
      version: entry.version,
      resolution: entry.integrity ?? entry.resolved ?? `${name}@${entry.version}`,
      local,
    })
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

  for (const [depPath, locations] of Object.entries<string[]>(modules.hoistedLocations ?? {})) {
    // a peer suffix, e.g. `react-dom@18.0.0(react@18.0.0)`, is not part of the package key
    const key = depPath.replace(/\(.*$/, '')
    const [name, version] = splitName(key)
    const resolution = packages[key]?.resolution
    const local = resolution?.type === 'directory' || /^(file|link):/.test(version)
    const entry: PackageState = {
      name,
      version: version.includes(':') ? undefined : version,
      resolution: `${depPath} ${JSON.stringify(resolution ?? null)}`,
      local,
    }
    for (const location of locations) state.set(location, entry)
  }

  for (const [importer, data] of Object.entries<any>(lock.importers ?? {})) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, dep] of Object.entries<any>(data?.[field] ?? {})) {
        const version: string | undefined = dep?.version
        if (!version?.startsWith('link:')) continue
        const location = posix.join(importer, 'node_modules', name)
        state.set(location, { name, resolution: version, local: true })
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
  for (const [locator, entry] of Object.entries(data)) {
    if (locator === '__metadata') continue
    const [name, reference] = splitName(locator)
    const local = /^(workspace|file|link|portal):/.test(reference)
    const version = reference.startsWith('npm:') ? reference.slice(4).split('::')[0] : undefined
    for (const location of entry?.locations ?? []) {
      // the root workspace
      if (!location) continue
      state.set(location, { name, version, resolution: locator, local })
    }
  }
  return state
}

export async function readYarnClassicState(root: string): Promise<InstallState> {
  const state: InstallState = new Map()
  const text = await readText(resolve(root, 'node_modules/.yarn-integrity'))
  if (!text) return state
  const integrity = JSON.parse(text)

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
      state.set(location, { name: manifest.name ?? key, resolution: `link:${await readlink(dir)}`, local: true })
      return
    }
    const urls = [...resolved.get(key) ?? []].sort()
    const matched = urls.filter(url => url.split('#')[0].endsWith(`-${manifest.version}.tgz`))
    state.set(location, {
      name: manifest.name ?? key,
      version: manifest.version,
      resolution: [manifest.version, ...matched.length ? matched : urls].join(' '),
      local: localNames.has(key),
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
  /** the absolute path of the location */
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
