import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { deserialize } from 'node:v8'
import { gunzipSync } from 'node:zlib'
import { parse } from 'yaml'
import { InstallState, PackageState, readText, realpath } from './state.ts'

/**
 * The install state of an isolated layout is computed from the records of the
 * agent, without access to the installed packages. Every package is
 * installed once in a store entry, and each dependency is a link from the
 * `node_modules` folder of its dependent, i.e. an importer or a store entry,
 * to the directory of the package. The state contains each store entry that
 * is a `node_modules` entry itself and each such link.
 */

/** the package that a location resolves to */
interface Target {
  name: string
  version?: string
  realPath: string
  local: boolean
}

function createState(realRoot: string) {
  const state: InstallState = new Map()
  const add = (path: string, target: Target) => {
    const location = relative(realRoot, path).split(sep).join('/')
    const { name, version, realPath, local } = target
    state.set(location, { name, version, resolution: local ? `link:${realPath}` : realPath, local, realPath } satisfies PackageState)
  }
  return { state, add }
}

/** A reader of `package.json` manifests, caching the parse of each directory. */
function createManifestReader() {
  const manifests = new Map<string, Promise<any>>()
  const readManifest = (dir: string) => {
    let manifest = manifests.get(dir)
    if (!manifest) {
      manifests.set(dir, manifest = readText(resolve(dir, 'package.json')).then((text) => {
        if (!text) return
        try {
          return JSON.parse(text)
        } catch {}
      }))
    }
    return manifest
  }
  const readName = async (dir: string) => {
    const name = (await readManifest(dir))?.name
    return typeof name === 'string' ? name : undefined
  }
  return { readManifest, readName }
}

/** Compare two versions of the form `major.minor.patch`, ignoring a prerelease or build suffix. */
export function compareVersions(a: string, b: string) {
  const parts = (version: string) => version.split(/[-+]/)[0].split('.').map(Number)
  const [x, y] = [parts(a), parts(b)]
  for (let index = 0; index < 3; index++) {
    const diff = (x[index] || 0) - (y[index] || 0)
    if (diff) return diff
  }
  return 0
}

/** the versions of pnpm whose isolated layout is supported, `[min, max)` */
export const PNPM_ISOLATED_VERSIONS = ['10.0.0', '12.0.0'] as const

/**
 * The versions of yarn whose pnpm linker is supported, `[min, max)`. Yarn
 * records the locations of the packages in the install state since 3.2.0.
 */
export const YARN_PNPM_LINKER_VERSIONS = ['3.2.0', '5.0.0'] as const

/** Whether a version is in the range `[min, max)`. */
export function isInRange(version: string, [min, max]: readonly [string, string]) {
  return compareVersions(version, min) >= 0 && compareVersions(version, max) < 0
}

/**
 * The prefixes of the version of a dependency path that are not the name of
 * a registry, so that `<name>@<prefix>:<version>` is not registry-qualified.
 */
const PNPM_RESERVED_VERSION_PREFIXES = new Set([
  'bitbucket', 'catalog', 'custom', 'file', 'git', 'github', 'gitlab', 'http',
  'https', 'jsr', 'link', 'npm', 'runtime', 'ssh', 'workspace',
])

const SEMVER = /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/

/** The version of a registry-qualified version slot `<registry>:<version>`. */
function parseRegistryQualifiedVersion(version: string) {
  const index = version.indexOf(':')
  if (index < 1) return
  const registry = version.slice(0, index)
  if (PNPM_RESERVED_VERSION_PREFIXES.has(registry) || !/^[A-Z][\w.-]*$/i.test(registry)) return
  const qualified = version.slice(index + 1)
  if (SEMVER.test(qualified)) return qualified
}

/**
 * The directory name of a dependency path in the virtual store, as pnpm
 * computes it in `depPathToFilename()` of `@pnpm/deps.path`. pnpm 11.28.0
 * escapes trailing dots and spaces, and pnpm 11.28.5 hashes a name whose
 * escaped location is ambiguous. A later version of pnpm 11 is treated as
 * pnpm 11.28.5.
 */
export function createDepPathToFilename(version: string) {
  const escapesTrailing = compareVersions(version, '11.28.0') >= 0
  const escapesAmbiguously = compareVersions(version, '11.28.5') >= 0

  const unescaped = (depPath: string) => {
    if (depPath.startsWith('file:')) return depPath.replace(':', '+')
    if (depPath[0] === '/') depPath = depPath.slice(1)
    return depPath
  }

  /** Whether escaping the location of a non-registry dependency can map two dependency paths to one name. */
  const isAmbiguous = (depPath: string) => {
    const id = depPath.split('(', 1)[0].replace(/^\//, '')
    const isFile = id.startsWith('file:')
    const separator = id.indexOf('@', 1)
    if (!isFile && separator === -1) return false
    const version = isFile ? id : id.slice(separator + 1)
    const schemeEnd = version.indexOf(':')
    if (schemeEnd === -1 || parseRegistryQualifiedVersion(version) !== undefined) return false
    return /[+\\:*?"<>|#]/.test(version.slice(schemeEnd + 1).replace(/^\/\//, ''))
  }

  return (depPath: string, maxLength: number) => {
    let filename = unescaped(depPath).replace(/[\\/:*?"<>|#]/g, '+')
    if (filename.includes('(')) {
      filename = filename.replace(/\)$/, '').replace(/\)\(|\(|\)/g, '_')
    }
    const ambiguous = escapesAmbiguously && isAmbiguous(depPath)
    const hashInput = ambiguous ? depPath : filename
    let trailing = false
    if (escapesTrailing) {
      const end = filename.length - /[. ]*$/.exec(filename)![0].length
      trailing = end < filename.length
      if (trailing) filename = filename.slice(0, end) + '+'.repeat(filename.length - end)
    }
    if (ambiguous || trailing || filename.length > maxLength || filename !== filename.toLowerCase() && !filename.startsWith('file+')) {
      const hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 32)
      return `${filename.slice(0, maxLength - 33)}_${hash}`
    }
    return filename
  }
}

/** The dependency path of a reference in a pnpm lockfile, as `refToRelative()` of `@pnpm/deps.path`. */
function refToRelative(reference: string, alias: string) {
  if (reference[0] === '@') return reference
  const atIndex = reference.indexOf('@')
  if (atIndex === -1) return `${alias}@${reference}`
  const colonIndex = reference.indexOf(':')
  const bracketIndex = reference.indexOf('(')
  if ((colonIndex === -1 || atIndex < colonIndex) && (bracketIndex === -1 || atIndex < bracketIndex)) return reference
  return `${alias}@${reference}`
}

/** The name and the version of a dependency path `<name>@<version>(<peers>)`. */
function parseDepPath(depPath: string) {
  const id = depPath.replace(/^\//, '')
  const index = id.indexOf('@', 1)
  if (index === -1) return
  const name = id.slice(0, index)
  const raw = id.slice(index + 1)
  const paren = raw.indexOf('(')
  const version = paren === -1 ? raw : raw.slice(0, paren)
  return {
    name,
    version: SEMVER.test(version) ? version : parseRegistryQualifiedVersion(version),
    // pnpm copies a package from a local directory into a store entry, which it updates in place
    local: version.startsWith('file:'),
  }
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
    // only ignore patterns, which exclude from every alias
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

const PNPM_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies']

/**
 * Read the install state of a pnpm isolated layout from the current lockfile
 * `node_modules/.pnpm/lock.yaml` and from `node_modules/.modules.yaml`. The
 * directory of a store entry is computed from its dependency path by the
 * rules of the version of pnpm that `.modules.yaml` records, i.e. the one
 * that installed the packages.
 */
export async function readPnpmIsolatedState(root: string): Promise<InstallState> {
  const realRoot = await realpath(root).catch(() => resolve(root))
  const { state, add } = createState(realRoot)
  const modulesDir = join(realRoot, 'node_modules')
  const [modulesText, lockText, workspaceStateText] = await Promise.all([
    readText(join(modulesDir, '.modules.yaml')),
    readText(join(modulesDir, '.pnpm/lock.yaml')),
    readText(join(modulesDir, '.pnpm-workspace-state-v1.json')),
  ])
  if (!lockText) return state
  const workspaceState = workspaceStateText ? JSON.parse(workspaceStateText) : undefined
  // the names of the workspace packages by directory
  const projectNames = new Map<string, string>()
  for (const [dir, { name }] of Object.entries<any>(workspaceState?.projects ?? {})) {
    if (typeof name === 'string') projectNames.set(resolve(dir), name)
  }
  // pnpm 11 writes `.modules.yaml` in JSON, which is also YAML
  const modules = modulesText ? parse(modulesText) ?? {} : {}
  const lock = parse(lockText) ?? {}
  // pnpm installs only `link:` dependencies without a store, i.e. without
  // `.modules.yaml`. The store entries are then read by no naming rule.
  const version = /^pnpm@(\d+\.\d+\.\d+)/.exec(modules.packageManager ?? '')?.[1]
  if (modulesText && (!version || !isInRange(version, PNPM_ISOLATED_VERSIONS))) {
    const [min, max] = PNPM_ISOLATED_VERSIONS
    const writer = modules.packageManager ?? 'an unknown agent'
    throw new Error(`${join(modulesDir, '.modules.yaml')} is written by ${writer}, only pnpm >=${min} <${max} is supported`)
  }
  const virtualStoreDir = resolve(modulesDir, modules.virtualStoreDir ?? '.pnpm')
  const store = await realpath(virtualStoreDir).catch(() => virtualStoreDir)
  const maxLength: number = modules.virtualStoreDirMaxLength
  const toFilename = version ? createDepPathToFilename(version) : () => ''
  const skipped = new Set<string>(modules.skipped ?? [])
  // the dependency types that the installation included; all by default
  const included = modules.included ?? {}
  const includeOptional = included.optionalDependencies !== false
  const importers: Record<string, any> = lock.importers ?? {}
  const { readManifest, readName } = createManifestReader()

  /** the store entry of a dependency path, and the `node_modules` folder of its dependencies */
  const entries = new Map<string, [Target, string] | undefined>()
  const getEntry = (depPath: string) => {
    if (entries.has(depPath)) return entries.get(depPath)
    let entry: [Target, string] | undefined
    const parsed = parseDepPath(depPath)
    if (parsed && !skipped.has(depPath)) {
      const folder = join(store, toFilename(depPath, maxLength), 'node_modules')
      entry = [{ name: parsed.name, version: parsed.version, realPath: join(folder, parsed.name), local: parsed.local }, folder]
    }
    entries.set(depPath, entry)
    return entry
  }

  const getLinked = async (path: string, alias: string): Promise<Target> => {
    // Node resolves a module through the real path of a link, so the target of
    // a local dependency is resolved too.
    const realPath = await realpath(path).catch(() => path)
    return { name: projectNames.get(path) ?? await readName(realPath) ?? alias, realPath, local: true }
  }

  const resolveReference = async (dir: string, alias: string, reference: unknown) => {
    if (typeof reference !== 'string') return
    if (reference.startsWith('link:')) return getLinked(resolve(dir, reference.slice(5)), alias)
    return getEntry(refToRelative(reference, alias))?.[0]
  }

  // A filtered installation, e.g. `pnpm install --filter`, installs only some
  // importers, while the lockfile still records every importer. The links of
  // an importer that was not installed are absent, and a link that was not
  // reinstalled may still point to the target of the previous installation.
  // So a checked link is read from its actual target, not the lockfile. The
  // snapshots in the current lockfile are already those of the installed
  // packages, so their links need no check.
  const filtered = workspaceState?.filteredInstall === true

  const tasks: Promise<void>[] = []
  /** whether each store entry of a dependency path in the current lockfile is local, by directory name */
  let localByEntry: Map<string, boolean> | undefined
  const getLocalByEntry = () => {
    if (localByEntry) return localByEntry
    localByEntry = new Map()
    if (!version) return localByEntry
    for (const depPath of new Set([...Object.keys(lock.snapshots ?? {}), ...Object.keys(lock.packages ?? {})])) {
      const parsed = parseDepPath(depPath)
      if (parsed) localByEntry.set(toFilename(depPath, maxLength), parsed.local)
    }
    return localByEntry
  }
  /**
   * Whether the content of a real directory is not identified by its location.
   * This holds for a directory outside the store, as for a `link:` target, and
   * for a store entry of a `file:` dependency, which pnpm updates in place.
   * A store entry is identified by the dependency path of the current lockfile
   * that names it. Otherwise, the escaped protocol `<name>@file+` or `file+`
   * tells a `file:` dependency, unless pnpm truncated the name before its hash
   * to `maxLength - 33` characters, which may remove the protocol, so that the
   * content is unknown and the entry is local.
   */
  const isLocalTarget = (path: string) => {
    const rel = relative(store, path)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true
    const entry = rel.split(sep)[0]
    const known = getLocalByEntry().get(entry)
    if (known !== undefined) return known
    if (/^file\+|@file\+/.test(entry)) return true
    const hashed = /^(.*)_[0-9a-f]{32}$/.exec(entry)
    return !!hashed && hashed[1].length >= maxLength - 33
  }
  const link = (folder: string, alias: string, target: Promise<Target | undefined> | Target | undefined, check = false) => {
    const location = join(folder, alias)
    tasks.push((async () => {
      let resolved = await target
      if (check && filtered) {
        // A filtered installation may leave a link pointing to the target of a
        // previous installation, which differs from the current declaration.
        // The name, version and content are read from the actual target.
        const realPath = await realpath(location).catch(() => undefined)
        if (!realPath) return
        const manifest = await readManifest(realPath)
        resolved = {
          name: typeof manifest?.name === 'string' ? manifest.name : resolved?.name ?? alias,
          version: typeof manifest?.version === 'string' ? manifest.version : undefined,
          realPath,
          local: isLocalTarget(realPath),
        }
      }
      if (resolved) add(location, resolved)
    })())
  }

  for (const [id, importer] of Object.entries(importers)) {
    const dir = resolve(realRoot, id)
    for (const field of PNPM_DEPENDENCY_FIELDS) {
      if (field === 'optionalDependencies' && !includeOptional) continue
      for (const [alias, dep] of Object.entries<any>(importer?.[field] ?? {})) {
        link(join(dir, 'node_modules'), alias, resolveReference(dir, alias, typeof dep === 'string' ? dep : dep?.version), true)
      }
    }
  }

  for (const [depPath, snapshot] of Object.entries<any>(lock.snapshots ?? {})) {
    const entry = getEntry(depPath)
    if (!entry) continue
    const [target, folder] = entry
    add(target.realPath, target)
    for (const field of ['dependencies', 'optionalDependencies']) {
      // pnpm keeps the optional dependencies in the snapshot even when the
      // installation excludes them, so that they are not linked.
      if (field === 'optionalDependencies' && !includeOptional) continue
      for (const [alias, reference] of Object.entries(snapshot?.[field] ?? {})) {
        // the location of the package itself
        if (alias === target.name) continue
        link(folder, alias, resolveReference(realRoot, alias, reference))
      }
    }
  }

  // pnpm 10 hoists the workspace packages without recording them in
  // `.modules.yaml`, unless another package is hoisted under the same name.
  if (version && compareVersions(version, '11.0.0') < 0 && workspaceState?.settings?.hoistWorkspacePackages) {
    const getHoistType = createHoistTypeGetter(modules.publicHoistPattern ?? [], modules.hoistPattern ?? [])
    // the aliases of the direct dependencies of the root in the virtual store and of the recorded hoisted dependencies
    const taken = new Set([
      ...PNPM_DEPENDENCY_FIELDS.flatMap(field => Object.entries<any>(importers['.']?.[field] ?? {})
        .filter(([, dep]) => !String(typeof dep === 'string' ? dep : dep?.version).startsWith('link:'))
        .map(([alias]) => alias)),
      ...Object.values<Record<string, string>>(modules.hoistedDependencies ?? {}).flatMap(aliases => Object.keys(aliases ?? {})),
    ].map(alias => alias.toLowerCase()))
    for (const [dir, { name }] of Object.entries<any>(workspaceState.projects ?? {})) {
      if (typeof name !== 'string' || resolve(dir) === realRoot || taken.has(name.toLowerCase())) continue
      const type = getHoistType(name)
      if (!type) continue
      // the link is absent if a filtered installation did not install the workspace
      link(type === 'public' ? modulesDir : join(store, 'node_modules'), name, { name, realPath: resolve(dir), local: true }, true)
    }
  }

  // The links of hoisted dependencies, by dependency path, or by importer for
  // the workspace packages, which pnpm 11 records.
  for (const [key, aliases] of Object.entries<Record<string, string>>(modules.hoistedDependencies ?? {})) {
    for (const [alias, type] of Object.entries(aliases ?? {})) {
      const folder = type === 'public' ? modulesDir : join(store, 'node_modules')
      const target = Object.hasOwn(importers, key) ? getLinked(resolve(realRoot, key), alias) : getEntry(key)?.[0]
      link(folder, alias, target)
    }
  }

  await Promise.all(tasks)
  return state
}

/**
 * The custom data of the pnpm linker of yarn in the install state. Yarn 4
 * records it in `linkersCustomData` under `PnpmLinker` version 3, and yarn 3
 * in `installersCustomData` under `PnpmInstaller` version 2.
 */
const YARN_PNPM_LINKER_DATA = {
  linkersCustomData: { name: 'PnpmLinker', version: 3 },
  installersCustomData: { name: 'PnpmInstaller', version: 2 },
} as const

/** Convert a portable path of yarn, e.g. `/C:/foo` or `/unc/server/share`, to a native path. */
function fromPortablePath(path: string) {
  if (process.platform !== 'win32') return path
  const drive = /^\/([a-zA-Z]:.*)$/.exec(path)
  if (drive) return drive[1].replace(/\//g, '\\')
  const unc = /^\/unc\/(.*)$/.exec(path)
  if (unc) return `\\\\${unc[1].replace(/\//g, '\\')}`
  return path.replace(/\//g, '\\')
}

interface YarnIdent {
  identHash: string
  scope: string | null
  name: string
}

interface YarnPackage extends YarnIdent {
  locatorHash: string
  reference: string
  version: string | null
  linkType: 'HARD' | 'SOFT'
  dependencies: Map<string, YarnIdent & { descriptorHash: string }>
}

/** the location of a package and the `node_modules` folder into which its dependencies are linked */
interface YarnPackagePaths {
  packageLocation: string
  dependenciesLocation: string | null
}

/** Read the paths of the packages from the custom data of the pnpm linker. */
function getYarnPackagePaths(data: any, installStatePath: string): Map<string, YarnPackagePaths> {
  const linker = data.linkersCustomData?.get(JSON.stringify(YARN_PNPM_LINKER_DATA.linkersCustomData))
  if (linker) return linker.pathsByLocator
  const installer = data.installersCustomData?.get(JSON.stringify(YARN_PNPM_LINKER_DATA.installersCustomData))
  if (installer) {
    // Yarn 3 installs a package from the store at a `node_modules` entry and
    // links the dependencies of every package into its own directory.
    const paths = new Map<string, YarnPackagePaths>()
    for (const [locatorHash, location] of installer.pathByLocator as Map<string, string>) {
      paths.set(locatorHash, { packageLocation: location, dependenciesLocation: `${location}/node_modules` })
    }
    return paths
  }
  const keys = [...data.linkersCustomData?.keys() ?? [], ...data.installersCustomData?.keys() ?? []].join(', ') || 'none'
  throw new Error(`${installStatePath} has no data of a supported pnpm linker, found ${keys}`)
}

function stringifyIdent(ident: YarnIdent) {
  return ident.scope ? `@${ident.scope}/${ident.name}` : ident.name
}

/** the reference of a virtual package without the virtual prefix `virtual:<hash>#` */
function devirtualize(reference: string) {
  return reference.replace(/^virtual:[^#]*#/, '')
}

/**
 * Read the install state of the pnpm linker of yarn from its install state
 * file. Yarn serializes the file with `v8.serialize()` of the Node.js that
 * runs it, and records the location of every package of the linker in it.
 * The format of the data of the linker determines the rules of linking.
 */
export async function readYarnBerryIsolatedState(root: string, installStatePath: string): Promise<InstallState> {
  const realRoot = await realpath(root).catch(() => resolve(root))
  const { state, add } = createState(realRoot)
  let buffer: Buffer
  try {
    buffer = await readFile(installStatePath)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return state
    throw error
  }
  let data: any
  try {
    data = deserialize(gunzipSync(buffer))
  } catch (cause) {
    throw new Error(`${installStatePath} cannot be read, it may be written by a newer version of Node.js`, { cause })
  }
  const isYarn3 = !data.linkersCustomData?.has(JSON.stringify(YARN_PNPM_LINKER_DATA.linkersCustomData))
  const paths = getYarnPackagePaths(data, installStatePath)
  const packages: Map<string, YarnPackage> = data.storedPackages
  const resolutions: Map<string, string> = data.storedResolutions
  const byReference = new Map<string, YarnPackage>()
  for (const pkg of packages.values()) byReference.set(`${pkg.identHash}#${pkg.reference}`, pkg)
  const { readName } = createManifestReader()

  const isWorkspace = (pkg: YarnPackage) => devirtualize(pkg.reference).startsWith('workspace:')

  const getTarget = async (pkg: YarnPackage): Promise<Target> => {
    const local = pkg.linkType === 'SOFT'
    const location = fromPortablePath(paths.get(pkg.locatorHash)!.packageLocation)
    // Node resolves a module through the real path of a link, so the target
    // of a local dependency, e.g. a `portal:` to a symlinked directory, is
    // resolved too. A package in the store is a real directory.
    const realPath = local ? await realpath(location).catch(() => location) : location
    const reference = devirtualize(pkg.reference)
    // a dependency on a local directory, whose ident is that of the dependency, which may be an alias
    const name = reference.startsWith('npm:') ? stringifyIdent(pkg) : await readName(realPath) ?? stringifyIdent(pkg)
    return { name, version: pkg.version ?? undefined, realPath, local }
  }

  const tasks: Promise<void>[] = []
  const link = (folder: string, alias: string, pkg: YarnPackage) => {
    tasks.push(getTarget(pkg).then(target => add(join(folder, alias), target)))
  }

  /**
   * The real directory from which the dependencies of a package are resolved.
   * Node resolves them through the real path of the package, so the location
   * of a soft-linked package, e.g. a `portal:` to a symlinked directory, is
   * resolved too. The last segment of `dependenciesLocation`, `node_modules`,
   * is kept, since it is not a link.
   */
  const dependenciesFolder = async (pkg: YarnPackage, dependenciesLocation: string) => {
    if (pkg.linkType !== 'SOFT') return dependenciesLocation
    const suffix = relative(fromPortablePath(paths.get(pkg.locatorHash)!.packageLocation), dependenciesLocation)
    return join((await getTarget(pkg)).realPath, suffix)
  }

  for (const locatorHash of data.accessibleLocators ?? []) {
    const pkg = packages.get(locatorHash)
    const location = paths.get(locatorHash)
    if (!pkg || !location?.dependenciesLocation) continue
    // the dependencies of a workspace are linked from the workspace itself
    if (pkg.reference.startsWith('virtual:') && isWorkspace(pkg)) continue
    const folder = await dependenciesFolder(pkg, fromPortablePath(location.dependenciesLocation))
    let linksItself = false
    for (const descriptor of pkg.dependencies.values()) {
      let dependency = packages.get(resolutions.get(descriptor.descriptorHash)!)
      if (!dependency) continue
      // yarn links the workspace instead of its virtual instance
      if (dependency.reference.startsWith('virtual:') && isWorkspace(dependency)) {
        dependency = byReference.get(`${dependency.identHash}#${devirtualize(dependency.reference)}`)
      }
      if (!dependency || !paths.has(dependency.locatorHash)) continue
      if (descriptor.identHash === pkg.identHash) linksItself = true
      link(folder, stringifyIdent(descriptor), dependency)
    }
    if (isWorkspace(pkg)) continue
    if (isYarn3) {
      // a package in the store is a `node_modules` entry itself
      if (pkg.linkType === 'HARD') tasks.push(getTarget(pkg).then(target => add(target.realPath, target)))
    } else if (!linksItself) {
      // a package in the store is linked into its own `node_modules` folder
      link(folder, stringifyIdent(pkg), pkg)
    }
  }

  await Promise.all(tasks)
  return state
}
