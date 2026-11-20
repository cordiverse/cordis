import { Dirent } from 'node:fs'
import { readdir, readlink } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import { createLocator, readText } from '../files.ts'
import { InstallState, nameOf, PackageState, splitName } from '../state.ts'

/**
 * A string of a yarn classic lockfile. Yarn quotes a string that contains
 * whitespace, a comma, a colon, a quote, a bracket or a backslash — and one that
 * does not start with a letter, such as `@scope/name` — with `JSON.stringify()`,
 * so that an unquoted string starts with a letter and contains none of them.
 */
const LOCKFILE_STRING = /"(?:[^"\\]|\\.)*"|[^\s",:[\]\\]+/g

function unquote(value: string) {
  if (!value.startsWith('"')) return value
  try {
    return JSON.parse(value) as string
  } catch {
    // a pattern that cannot be read is not found, so that its version is unknown
    return value
  }
}

/** the version of each pattern of `yarn.lock` */
function parseLockVersions(text: string) {
  const versions = new Map<string, string>()
  let patterns: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    if (!/^\s/.test(line)) {
      patterns = (line.match(LOCKFILE_STRING) ?? []).map(unquote)
      continue
    }
    const capture = /^ {2}version (.+)$/.exec(line)
    if (capture) for (const pattern of patterns) versions.set(pattern, unquote(capture[1].trim()))
  }
  return versions
}

/** the fields of `node_modules/.yarn-integrity` that the reader uses */
interface YarnIntegrity {
  modulesFolders?: string[]
  linkedModules?: string[]
  /** the resolved URL of each pattern of `yarn.lock` */
  lockfileEntries?: Record<string, string>
}

/**
 * Read the install state of yarn classic. The records of yarn classic do not
 * contain the locations of the packages, so the `node_modules` folders are read.
 */
export async function readYarnClassicState(root: string): Promise<InstallState> {
  const state: InstallState = new Map()
  const [text, lockText] = await Promise.all([
    readText(resolve(root, 'node_modules/.yarn-integrity')),
    readText(resolve(root, 'yarn.lock')),
  ])
  if (!text) return state
  const integrity: YarnIntegrity = JSON.parse(text)
  const versions = parseLockVersions(lockText ?? '')
  const locate = await createLocator(root)

  // name → version → sources, where an unknown version is `undefined`
  const resolved = new Map<string, Map<string | undefined, Set<string>>>()
  const localNames = new Set<string>(integrity.linkedModules ?? [])
  for (const [pattern, url] of Object.entries(integrity.lockfileEntries ?? {})) {
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
      state.set(location, { name: manifest.name ?? key, resolution: `link:${await readlink(dir)}`, local: true, realpath: await locate(location, true) })
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
      realpath: await locate(location, identity.local),
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
