import { readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { deserialize } from 'node:v8'
import { gunzipSync } from 'node:zlib'
import { parse } from 'yaml'
import { createLocator, createManifestReader, readText, realpath } from '../files.ts'
import { createIsolatedState, InstallState, splitName, Target } from '../state.ts'

/**
 * The versions of yarn whose pnpm linker is supported, `[min, max)`. Yarn
 * records the locations of the packages in the install state since 3.2.0.
 */
export const YARN_PNPM_LINKER_VERSIONS = ['3.2.0', '5.0.0'] as const

/** the reference of a virtual package, which has peer dependencies, without the prefix `virtual:<hash>#` */
function devirtualize(reference: string) {
  return reference.replace(/^virtual:[^#]*#/, '')
}

interface NodeModulesStateEntry {
  locations?: string[]
}

/** Read the install state of the node-modules linker from `node_modules/.yarn-state.yml`. */
export async function readYarnBerryHoistedState(root: string): Promise<InstallState> {
  const state: InstallState = new Map()
  const text = await readText(resolve(root, 'node_modules/.yarn-state.yml'))
  if (!text) return state
  const data: Record<string, NodeModulesStateEntry> = parse(text) ?? {}
  const locate = await createLocator(root)
  const { readName } = createManifestReader()
  for (const [locator, entry] of Object.entries(data)) {
    if (locator === '__metadata') continue
    const [ident, raw] = splitName(locator)
    // a package with peer dependencies, e.g. `virtual:<hash>#workspace:packages/foo`
    const reference = devirtualize(raw)
    const local = /^(workspace|file|link|portal):/.test(reference)
    const version = reference.startsWith('npm:') ? reference.slice(4).split('::')[0] : undefined
    for (const location of entry?.locations ?? []) {
      // the root workspace
      if (!location) continue
      // the ident of a local package is that of its dependency, which may be an alias
      const name = local ? await readName(resolve(root, location)) ?? ident : ident
      state.set(location, { name, version, resolution: locator, local, realpath: await locate(location, local) })
    }
  }
  return state
}

interface YarnIdent {
  identHash: string
  scope: string | null
  name: string
}

/** a package of `storedPackages` in the install state */
interface YarnPackage extends YarnIdent {
  locatorHash: string
  reference: string
  version: string | null
  /** `SOFT` for a package used at its own directory, e.g. a workspace or a `portal:` dependency */
  linkType: 'HARD' | 'SOFT'
  dependencies: Map<string, YarnIdent & { descriptorHash: string }>
}

/** the location of a package and the `node_modules` folder into which its dependencies are linked */
interface YarnPackagePaths {
  packageLocation: string
  dependenciesLocation: string | null
}

/**
 * The fields of `.yarn/install-state.gz` that the reader uses. The custom
 * data of the pnpm linker is recorded:
 *
 * - by yarn 4, in `linkersCustomData` under `{"name":"PnpmLinker","version":3}`;
 * - by yarn 3.2 and later, in `installersCustomData` under `{"name":"PnpmInstaller","version":2}`.
 */
interface YarnInstallState {
  linkersCustomData?: Map<string, { pathsByLocator: Map<string, YarnPackagePaths> }>
  installersCustomData?: Map<string, { pathByLocator: Map<string, string> }>
  accessibleLocators?: Set<string>
  storedPackages: Map<string, YarnPackage>
  /** the locator hash of each descriptor hash */
  storedResolutions: Map<string, string>
}

const PNPM_LINKER_KEY = JSON.stringify({ name: 'PnpmLinker', version: 3 })
const PNPM_INSTALLER_KEY = JSON.stringify({ name: 'PnpmInstaller', version: 2 })

/**
 * Read the paths of the packages from the custom data of the pnpm linker.
 * The formats determine the layout of a store entry:
 *
 * - yarn 4 installs the package at `<entry>/package` and links it and its
 *   dependencies into `<entry>/node_modules`;
 * - yarn 3 installs the package at `<entry>/node_modules/<name>` and links
 *   its dependencies into the `node_modules` folder of the package.
 */
function readPnpmLinkerData(data: YarnInstallState, installStatePath: string) {
  const linker = data.linkersCustomData?.get(PNPM_LINKER_KEY)
  if (linker) return { paths: linker.pathsByLocator, linksStoreEntries: true }
  const installer = data.installersCustomData?.get(PNPM_INSTALLER_KEY)
  if (installer) {
    const paths = new Map<string, YarnPackagePaths>()
    for (const [locatorHash, location] of installer.pathByLocator) {
      paths.set(locatorHash, { packageLocation: location, dependenciesLocation: `${location}/node_modules` })
    }
    return { paths, linksStoreEntries: false }
  }
  const keys = [...data.linkersCustomData?.keys() ?? [], ...data.installersCustomData?.keys() ?? []].join(', ') || 'none'
  throw new Error(`${installStatePath} has no data of a supported pnpm linker, found ${keys}`)
}

/** Convert a portable path of yarn, e.g. `/C:/foo` or `/unc/server/share`, to a native path. */
function fromPortablePath(path: string) {
  if (process.platform !== 'win32') return path
  const drive = /^\/([a-zA-Z]:.*)$/.exec(path)
  if (drive) return drive[1].replace(/\//g, '\\')
  const unc = /^\/unc\/(.*)$/.exec(path)
  if (unc) return `\\\\${unc[1].replace(/\//g, '\\')}`
  return path.replace(/\//g, '\\')
}

function stringifyIdent(ident: YarnIdent) {
  return ident.scope ? `@${ident.scope}/${ident.name}` : ident.name
}

/**
 * Read the install state of the pnpm linker from the install state file,
 * which records the location of every package. Yarn serializes the file with
 * `v8.serialize()` of the Node.js that runs it. The installed packages are
 * read only for the real directory and the manifest of a local target.
 */
export async function readYarnBerryIsolatedState(root: string, installStatePath: string): Promise<InstallState> {
  const realRoot = await realpath(root).catch(() => resolve(root))
  const { state, add } = createIsolatedState(realRoot)
  let buffer: Buffer
  try {
    buffer = await readFile(installStatePath)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return state
    throw error
  }
  let data: YarnInstallState
  try {
    data = deserialize(gunzipSync(buffer))
  } catch (cause) {
    throw new Error(`${installStatePath} cannot be read, it may be written by a newer version of Node.js`, { cause })
  }
  const { paths, linksStoreEntries } = readPnpmLinkerData(data, installStatePath)
  const packages = data.storedPackages
  const resolutions = data.storedResolutions
  const byReference = new Map<string, YarnPackage>()
  for (const pkg of packages.values()) byReference.set(`${pkg.identHash}#${pkg.reference}`, pkg)
  const { readName } = createManifestReader()

  const isWorkspace = (pkg: YarnPackage) => devirtualize(pkg.reference).startsWith('workspace:')
  const locationOf = (pkg: YarnPackage) => fromPortablePath(paths.get(pkg.locatorHash)!.packageLocation)

  const targets = new Map<string, Promise<Target>>()
  const getTarget = (pkg: YarnPackage) => {
    let target = targets.get(pkg.locatorHash)
    if (!target) {
      targets.set(pkg.locatorHash, target = (async () => {
        const local = pkg.linkType === 'SOFT'
        const location = locationOf(pkg)
        // Node resolves the real directory of a local package, e.g. a `portal:`
        // to a symlinked directory, through every link, while a package in the
        // store is a real directory.
        const realDir = local ? await realpath(location).catch(() => location) : location
        // a dependency on a local directory, whose ident is that of the dependency, which may be an alias
        const name = devirtualize(pkg.reference).startsWith('npm:') ? stringifyIdent(pkg) : await readName(realDir) ?? stringifyIdent(pkg)
        return { name, version: pkg.version ?? undefined, realpath: realDir, local }
      })())
    }
    return target
  }

  /**
   * The folder from which Node resolves the dependencies of a package, i.e.
   * `dependenciesLocation` below the real directory of a local package.
   */
  const getDependenciesFolder = async (pkg: YarnPackage, dependenciesLocation: string) => {
    if (pkg.linkType !== 'SOFT') return dependenciesLocation
    return join((await getTarget(pkg)).realpath, relative(locationOf(pkg), dependenciesLocation))
  }

  const tasks: Promise<void>[] = []
  const addLink = (location: string, pkg: YarnPackage) => {
    tasks.push(getTarget(pkg).then(target => add(location, target)))
  }

  for (const locatorHash of data.accessibleLocators ?? []) {
    const pkg = packages.get(locatorHash)
    const location = paths.get(locatorHash)
    if (!pkg || !location?.dependenciesLocation) continue
    // the dependencies of a workspace are linked from the workspace itself
    if (pkg.reference.startsWith('virtual:') && isWorkspace(pkg)) continue
    const folder = await getDependenciesFolder(pkg, fromPortablePath(location.dependenciesLocation))
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
      addLink(join(folder, stringifyIdent(descriptor)), dependency)
    }
    if (isWorkspace(pkg)) continue
    if (linksStoreEntries) {
      // a package in the store is linked into its own `node_modules` folder
      if (!linksItself) addLink(join(folder, stringifyIdent(pkg)), pkg)
    } else if (pkg.linkType === 'HARD') {
      // a package in the store is a `node_modules` entry itself
      tasks.push(getTarget(pkg).then(target => add(target.realpath, target)))
    }
  }

  await Promise.all(tasks)
  return state
}
