import { createHash } from 'node:crypto'
import { compareVersions } from '../version.ts'

/**
 * The rules of pnpm for dependency paths, i.e. the keys of `snapshots` and
 * `packages` in a lockfile such as `foo@1.0.0(bar@2.0.0)`, and for the names
 * of their store entries.
 */

/**
 * The prefixes of the version of a dependency path that are not the name of
 * a registry, so that `<name>@<prefix>:<version>` is not registry-qualified.
 */
const RESERVED_VERSION_PREFIXES = new Set([
  'bitbucket', 'catalog', 'custom', 'file', 'git', 'github', 'gitlab', 'http',
  'https', 'jsr', 'link', 'npm', 'runtime', 'ssh', 'workspace',
])

const SEMVER = /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/

/** The version of a registry-qualified version slot `<registry>:<version>`. */
function parseRegistryQualifiedVersion(version: string) {
  const index = version.indexOf(':')
  if (index < 1) return
  const registry = version.slice(0, index)
  if (RESERVED_VERSION_PREFIXES.has(registry) || !/^[A-Z][\w.-]*$/i.test(registry)) return
  const qualified = version.slice(index + 1)
  if (SEMVER.test(qualified)) return qualified
}

/** The dependency path of a reference in a lockfile, as `refToRelative()` of `@pnpm/deps.path`. */
export function refToRelative(reference: string, alias: string) {
  if (reference[0] === '@') return reference
  const atIndex = reference.indexOf('@')
  if (atIndex === -1) return `${alias}@${reference}`
  const colonIndex = reference.indexOf(':')
  const bracketIndex = reference.indexOf('(')
  if ((colonIndex === -1 || atIndex < colonIndex) && (bracketIndex === -1 || atIndex < bracketIndex)) return reference
  return `${alias}@${reference}`
}

export interface ParsedDepPath {
  name: string
  /** the version of a registry package, or `undefined` for another source */
  version?: string
  /** whether the dependency is a `file:` directory, whose store entry pnpm updates in place */
  local: boolean
}

export function parseDepPath(depPath: string): ParsedDepPath | undefined {
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
    local: version.startsWith('file:'),
  }
}

/** the length of `_<hash>` that pnpm appends to a hashed directory name */
const HASH_SUFFIX_LENGTH = 33

/**
 * Create `depPathToFilename()` of `@pnpm/deps.path` for a version of pnpm,
 * which names the store entry of a dependency path. The versions differ:
 *
 * - since pnpm 11.28.0, trailing dots and spaces are escaped;
 * - since pnpm 11.28.5, a name whose escaped location is ambiguous is hashed.
 *
 * A later version of pnpm 11 is treated as pnpm 11.28.5.
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
      return `${filename.slice(0, maxLength - HASH_SUFFIX_LENGTH)}_${hash}`
    }
    return filename
  }
}

/**
 * Whether a store entry name may belong to a `file:` dependency, judged from
 * the name alone. This holds for:
 *
 * - a name that contains the escaped protocol, i.e. starts with `file+` or contains `@file+`;
 * - a hashed name that pnpm truncated to `maxLength - 33` characters, which may have removed the protocol.
 */
export function mayBeFileDirectory(directory: string, maxLength: number) {
  if (/^file\+|@file\+/.test(directory)) return true
  const hashed = /^(.*)_[0-9a-f]{32}$/.exec(directory)
  return !!hashed && hashed[1].length >= maxLength - HASH_SUFFIX_LENGTH
}
