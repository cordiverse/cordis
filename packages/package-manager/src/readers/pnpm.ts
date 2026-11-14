import { readlink } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { parse } from 'yaml'
import { createLocator, createManifestReader, createRootSpelling, isWithin, readText, realpath } from '../files.ts'
import { createIsolatedState, InstallState, splitName, Target } from '../state.ts'
import { compareVersions, isInRange } from '../version.ts'
import { createDepPathToFilename, mayBeFileDirectory, parseDepPath, refToRelative } from './pnpm-path.ts'

/** the versions of pnpm whose isolated layout is supported, `[min, max)` */
export const PNPM_ISOLATED_VERSIONS = ['10.0.0', '12.0.0'] as const

/** the fields of `node_modules/.modules.yaml` that the readers use */
interface PnpmModules {
  /** the agent that installed the packages, e.g. `pnpm@10.33.0` */
  packageManager?: string
  /** relative to `node_modules` */
  virtualStoreDir?: string
  /** the maximal length of a store entry name, which every supported version of pnpm records */
  virtualStoreDirMaxLength: number
  /** the dependency paths that were not installed, e.g. an optional dependency for another platform */
  skipped?: string[]
  /** `false` for a dependency type that the installation excluded */
  included?: { optionalDependencies?: boolean }
  hoistPattern?: string[]
  publicHoistPattern?: string[]
  /** the hoisted aliases with their hoist types, by dependency path, or by importer for a workspace package */
  hoistedDependencies?: Record<string, Record<string, 'public' | 'private'>>
  /** the locations of each dependency path in a hoisted layout */
  hoistedLocations?: Record<string, string[]>
}

/** a dependency of an importer, whose `version` is the reference of the installed package */
type PnpmImporterDependency = string | { version?: string }

type PnpmDependencyField = 'dependencies' | 'devDependencies' | 'optionalDependencies'

/** the fields of the current lockfile `node_modules/.pnpm/lock.yaml` that the readers use */
interface PnpmLockfile {
  importers?: Record<string, Partial<Record<PnpmDependencyField, Record<string, PnpmImporterDependency>>>>
  packages?: Record<string, { resolution?: { type?: string } }>
  /** the dependencies of each installed dependency path */
  snapshots?: Record<string, Partial<Record<'dependencies' | 'optionalDependencies', Record<string, string>>>>
}

/** the fields of `node_modules/.pnpm-workspace-state-v1.json` that the reader uses */
interface PnpmWorkspaceState {
  /** whether the last installation installed only some importers, e.g. `pnpm install --filter` */
  filteredInstall?: boolean
  settings?: { hoistWorkspacePackages?: boolean }
  /** the workspace packages by real directory */
  projects?: Record<string, { name?: string }>
}

/** Read the records of pnpm in `node_modules`, which both layouts write. */
async function readRecords(root: string) {
  const [modulesText, lockText] = await Promise.all([
    readText(join(root, 'node_modules/.modules.yaml')),
    readText(join(root, 'node_modules/.pnpm/lock.yaml')),
  ])
  return {
    // pnpm 11 writes `.modules.yaml` in JSON, which is also YAML
    modules: modulesText ? (parse(modulesText) ?? {}) as PnpmModules : undefined,
    lock: lockText ? (parse(lockText) ?? {}) as PnpmLockfile : undefined,
  }
}

function referenceOf(dependency: PnpmImporterDependency | undefined) {
  return typeof dependency === 'string' ? dependency : dependency?.version
}

const DEPENDENCY_FIELDS: PnpmDependencyField[] = ['dependencies', 'devDependencies', 'optionalDependencies']

/**
 * Read the install state of a hoisted layout. `.modules.yaml` gives the locations of
 * the packages; a `link:` dependency of an importer is read from the lockfile and
 * named after the manifest at its target, which `.modules.yaml` does not record.
 */
export async function readPnpmHoistedState(root: string): Promise<InstallState> {
  const state: InstallState = new Map()
  const { modules, lock = {} } = await readRecords(root)
  if (!modules) return state
  const packages = lock.packages ?? {}
  const locate = await createLocator(root)
  const { readName } = createManifestReader()

  for (const [depPath, locations] of Object.entries(modules.hoistedLocations ?? {})) {
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
        realpath: await locate(location, local),
      })
    }
  }

  for (const [importer, data] of Object.entries(lock.importers ?? {})) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, dependency] of Object.entries(data?.[field] ?? {})) {
        const reference = referenceOf(dependency)
        if (!reference?.startsWith('link:')) continue
        const location = posix.join(importer, 'node_modules', name)
        const target = resolve(root, importer, reference.slice(5))
        state.set(location, { name: await readName(target) ?? name, resolution: reference, local: true, realpath: await locate(location, true) })
      }
    }
  }
  return state
}

/** Match an alias against hoist patterns, as `createMatcher()` of `@pnpm/config.matcher`. */
function createPatternMatcher(patterns: string[]) {
  const matchers = patterns.map((pattern) => {
    const ignore = pattern.startsWith('!')
    if (ignore) pattern = pattern.slice(1)
    const regexp = new RegExp(`^${pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*')}$`)
    return { ignore, match: (input: string) => regexp.test(input) }
  })
  if (!matchers.some(({ ignore }) => !ignore)) {
    // without an include pattern, an alias matches unless an ignore pattern matches it; no
    // pattern at all matches nothing
    return (input: string) => matchers.length > 0 && !matchers.some(({ match }) => match(input))
  }
  return (input: string) => {
    let matched = false
    for (const { ignore, match } of matchers) {
      if (ignore) {
        if (match(input)) matched = false
      } else if (!matched && match(input)) {
        matched = true
      }
    }
    return matched
  }
}

function createHoistTypeGetter(publicPatterns: string[], privatePatterns: string[]) {
  const isPublic = createPatternMatcher(publicPatterns)
  const isPrivate = createPatternMatcher(privatePatterns)
  return (alias: string) => isPublic(alias) ? 'public' : isPrivate(alias) ? 'private' : undefined
}

interface StoreEntry {
  /** the directory name in the virtual store */
  directory: string
  /** the package at its own location in the store entry */
  target: Target
  /** the `node_modules` folder of the store entry, which holds the package and the links of its dependencies */
  dependenciesLocation: string
}

/**
 * Create the store entries of the dependency paths, each parsed and named
 * once. Without the version of pnpm, whose rules name the entries, no
 * dependency path has an entry. The paths are in the spelling of the store.
 */
function createVirtualStore(store: string, version: string | undefined, modules: PnpmModules, lock: PnpmLockfile) {
  const toFilename = version ? createDepPathToFilename(version) : undefined
  const maxLength = modules.virtualStoreDirMaxLength
  const skipped = new Set(modules.skipped)

  const entries = new Map<string, StoreEntry | undefined>()
  const describe = (depPath: string) => {
    if (entries.has(depPath)) return entries.get(depPath)
    let entry: StoreEntry | undefined
    const parsed = toFilename && parseDepPath(depPath)
    if (parsed) {
      const directory = toFilename(depPath, maxLength)
      const dependenciesLocation = join(store, directory, 'node_modules')
      const { name, version, local } = parsed
      entry = { directory, dependenciesLocation, target: { name, version, realpath: join(dependenciesLocation, name), local } }
    }
    entries.set(depPath, entry)
    return entry
  }

  /** whether each store entry of the lockfile is local, by directory name */
  let localByDirectory: Map<string, boolean> | undefined
  const getLocalByDirectory = () => {
    if (localByDirectory) return localByDirectory
    localByDirectory = new Map()
    for (const depPath of new Set([...Object.keys(lock.snapshots ?? {}), ...Object.keys(lock.packages ?? {})])) {
      const entry = describe(depPath)
      if (entry) localByDirectory.set(entry.directory, entry.target.local)
    }
    return localByDirectory
  }

  return {
    /** the installed store entry of a dependency path */
    getEntry: (depPath: string) => skipped.has(depPath) ? undefined : describe(depPath),
    /**
     * Whether a package at a real directory is local. This holds for:
     *
     * - a directory outside the store, e.g. a `link:` target;
     * - a store entry of a `file:` dependency, judged by the dependency path
     *   of the lockfile that names the entry, and otherwise by its name, so
     *   that an entry of unknown source is local.
     *
     * The real directory is given in the spelling of the project root.
     */
    isLocal(realDir: string) {
      const rel = relative(store, realDir)
      if (!rel || !isWithin(realDir, store)) return true
      const directory = rel.split(sep)[0]
      return getLocalByDirectory().get(directory) ?? mayBeFileDirectory(directory, maxLength)
    },
  }
}

/**
 * Read the install state of an isolated layout from the records of pnpm in
 * `node_modules`:
 *
 * - the current lockfile `.pnpm/lock.yaml`, which records the dependencies
 *   of every importer and every store entry;
 * - `.modules.yaml`, which records the hoisted links and the version of pnpm
 *   that installed the packages, whose rules name the store entries.
 *
 * The installed packages are read only for the real directory and the
 * manifest of a local target, and for the links of the importers after a
 * filtered installation.
 */
export async function readPnpmIsolatedState(root: string): Promise<InstallState> {
  const realRoot = await realpath(root).catch(() => resolve(root))
  const { state, add } = createIsolatedState(realRoot)
  const modulesDir = join(realRoot, 'node_modules')
  const [{ modules, lock }, workspaceStateText] = await Promise.all([
    readRecords(realRoot),
    readText(join(modulesDir, '.pnpm-workspace-state-v1.json')),
  ])
  if (!lock) return state
  // pnpm writes no `.modules.yaml` for an installation of only `link:`
  // dependencies, which has no store entry to name.
  let version: string | undefined
  if (modules) {
    version = /^pnpm@(\d+\.\d+\.\d+)/.exec(modules.packageManager ?? '')?.[1]
    if (!version || !isInRange(version, PNPM_ISOLATED_VERSIONS)) {
      const [min, max] = PNPM_ISOLATED_VERSIONS
      const writer = modules.packageManager ?? 'an unknown agent'
      throw new Error(`${join(modulesDir, '.modules.yaml')} is written by ${writer}, only pnpm >=${min} <${max} is supported`)
    }
  }
  const settings = modules ?? {} as PnpmModules
  const workspaceState: PnpmWorkspaceState = workspaceStateText ? JSON.parse(workspaceStateText) : {}
  const importers = lock.importers ?? {}
  // pnpm records the absolute paths of the virtual store on Windows and of the
  // workspace packages in the native spelling of the project root.
  const toRoot = await createRootSpelling(realRoot)
  const virtualStoreDir = resolve(modulesDir, settings.virtualStoreDir ?? '.pnpm')
  /** the store in the spelling of the project root, in which the locations are */
  const storeDir = toRoot(await realpath(virtualStoreDir).catch(() => virtualStoreDir))

  const store = createVirtualStore(storeDir, version, settings, lock)
  const manifests = createManifestReader()
  // pnpm keeps the optional dependencies in the records even when the
  // installation excludes them, so that they are not linked.
  const includesOptional = settings.included?.optionalDependencies !== false
  const importerFields = DEPENDENCY_FIELDS.filter(field => includesOptional || field !== 'optionalDependencies')
  const snapshotFields = (['dependencies', 'optionalDependencies'] as const).filter(field => includesOptional || field !== 'optionalDependencies')

  /** the workspace packages, by directory in the spelling of the project root */
  const projects = new Map<string, string>()
  for (const [dir, { name }] of Object.entries(workspaceState.projects ?? {})) {
    if (typeof name === 'string') projects.set(toRoot(resolve(dir)), name)
  }

  // pnpm links a store entry with a relative symbolic link, except on
  // Windows, where it creates a junction with an absolute target, always
  // before pnpm 11 and since then without the permission for symbolic links.
  // It keeps an existing link to the right entry, so that one installation
  // may contain both kinds. Node resolves a relative link in the spelling of
  // the link, i.e. of `storeDir`, and an absolute link in the spelling of its
  // target, which may differ from the recorded store. Each link that may be
  // absolute is therefore read.
  const mayLinkAbsolute = process.platform === 'win32'

  /** the real directories of the spellings of the store in absolute targets */
  const resolvedStores = new Map<string, Promise<string>>()

  /** the target of a link at a location to the store entry of a dependency path */
  const getEntryTarget = async (location: string, depPath: string): Promise<Target | undefined> => {
    const target = store.getEntry(depPath)?.target
    if (!target || !mayLinkAbsolute) return target
    const linkTarget = await readlink(location).catch(() => undefined)
    if (linkTarget === undefined || !isAbsolute(linkTarget)) return target
    const path = resolve(linkTarget)
    // a link to a directory other than the recorded entry is resolved as is
    if (relative(target.realpath, toRoot(path))) {
      return { ...target, realpath: await realpath(location).catch(() => path) }
    }
    // Node also resolves the links along the target, which are those of the
    // store, since a store entry contains no link to its own package.
    const prefix = resolve(path, relative(target.realpath, storeDir))
    let realStore = resolvedStores.get(prefix)
    if (!realStore) resolvedStores.set(prefix, realStore = realpath(prefix).catch(() => prefix))
    return { ...target, realpath: join(await realStore, relative(prefix, path)) }
  }

  /**
   * The target of a link to a directory outside the store, as a `link:`
   * dependency or a hoisted workspace package. Node resolves the real
   * directory through the link, and through the declared path if the link is
   * absent.
   */
  const getLinked = async (location: string, path: string, alias: string): Promise<Target> => {
    const realDir = await realpath(location).catch(() => realpath(path)).catch(() => path)
    const name = projects.get(toRoot(realDir)) ?? await manifests.readName(realDir) ?? alias
    return { name, realpath: realDir, local: true }
  }

  /** the target that the records give to the link of a dependent in a directory */
  const fromRecords = (location: string, dir: string, alias: string, reference: string | undefined) => {
    if (typeof reference !== 'string') return
    if (reference.startsWith('link:')) return getLinked(location, resolve(dir, reference.slice(5)), alias)
    return getEntryTarget(location, refToRelative(reference, alias))
  }

  /**
   * The target of the link at a location, read from the link itself. A target
   * without a name in its manifest is named after the alias, since the
   * lockfile may not describe a link that a filtered installation left.
   */
  const fromLink = async (location: string, alias: string): Promise<Target | undefined> => {
    const realDir = await realpath(location).catch(() => undefined)
    if (!realDir) return
    const manifest = await manifests.readManifest(realDir)
    return {
      name: manifest?.name ?? alias,
      version: manifest?.version,
      realpath: realDir,
      local: store.isLocal(toRoot(realDir)),
    }
  }

  const tasks: Promise<void>[] = []
  const addLink = (location: string, target: Promise<Target | undefined> | Target | undefined) => {
    tasks.push(Promise.resolve(target).then((target) => {
      if (target) add(location, target)
    }))
  }

  // A filtered installation, e.g. `pnpm install --filter`, installs only some
  // importers, while the lockfile records every importer. For an importer
  // that it did not install, the installation
  //
  // - creates no link that the lockfile records;
  // - leaves an existing link pointing to its previous target.
  //
  // The links of the importers are therefore read from the links themselves.
  // The snapshots of the current lockfile are those of the installed store
  // entries, so the links between store entries are read from them.
  const filtered = workspaceState.filteredInstall === true

  for (const [id, importer] of Object.entries(importers)) {
    const dir = resolve(realRoot, id)
    for (const field of importerFields) {
      for (const [alias, dependency] of Object.entries(importer?.[field] ?? {})) {
        const location = join(dir, 'node_modules', alias)
        addLink(location, filtered ? fromLink(location, alias) : fromRecords(location, dir, alias, referenceOf(dependency)))
      }
    }
  }

  for (const [depPath, snapshot] of Object.entries(lock.snapshots ?? {})) {
    const entry = store.getEntry(depPath)
    if (!entry) continue
    add(entry.target.realpath, entry.target)
    for (const field of snapshotFields) {
      for (const [alias, reference] of Object.entries(snapshot?.[field] ?? {})) {
        // the location of the package itself
        if (alias === entry.target.name) continue
        const location = join(entry.dependenciesLocation, alias)
        addLink(location, fromRecords(location, realRoot, alias, reference))
      }
    }
  }

  const hoistFolder = (type: 'public' | 'private') => type === 'public' ? modulesDir : join(storeDir, 'node_modules')

  // pnpm 10 hoists the workspace packages without recording them in
  // `.modules.yaml`, unless another package is hoisted under the same name.
  if (version && compareVersions(version, '11.0.0') < 0 && workspaceState.settings?.hoistWorkspacePackages) {
    const getHoistType = createHoistTypeGetter(settings.publicHoistPattern ?? [], settings.hoistPattern ?? [])
    // the aliases of the direct dependencies of the root in the virtual store and of the recorded hoisted dependencies
    const taken = new Set([
      ...DEPENDENCY_FIELDS.flatMap(field => Object.entries(importers['.']?.[field] ?? {})
        .filter(([, dependency]) => !String(referenceOf(dependency)).startsWith('link:'))
        .map(([alias]) => alias)),
      ...Object.values(settings.hoistedDependencies ?? {}).flatMap(aliases => Object.keys(aliases ?? {})),
    ].map(alias => alias.toLowerCase()))
    for (const [dir, name] of projects) {
      if (dir === realRoot || taken.has(name.toLowerCase())) continue
      const type = getHoistType(name)
      if (!type) continue
      const location = join(hoistFolder(type), name)
      // a filtered installation does not hoist a workspace that it did not install
      addLink(location, filtered ? fromLink(location, name) : getLinked(location, dir, name))
    }
  }

  // The links of hoisted dependencies, by dependency path, or by importer for
  // the workspace packages, which pnpm 11 records.
  for (const [key, aliases] of Object.entries(settings.hoistedDependencies ?? {})) {
    for (const [alias, type] of Object.entries(aliases ?? {})) {
      const location = join(hoistFolder(type), alias)
      addLink(location, Object.hasOwn(importers, key) ? getLinked(location, resolve(realRoot, key), alias) : getEntryTarget(location, key))
    }
  }

  await Promise.all(tasks)
  return state
}
