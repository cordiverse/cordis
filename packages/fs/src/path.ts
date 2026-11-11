import { posix, resolve as resolveNative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// `C:` is relative to the current directory of drive C, which depends on the
// process. A separator after the colon names a location.
const driveRelative = /^[a-zA-Z]:(?![\\/])/

// characters that a URL parser reads as syntax or drops, and `|`, which turns a
// segment like `a|` into a drive letter
// eslint-disable-next-line no-control-regex
const special = /[\x00-\x20%#?|\\\x7f]/g

function encodeSegment(segment: string) {
  return segment.replace(special, encodeURIComponent)
}

/**
 * Resolve a path against `base`, which defaults to the working directory. A
 * string path is taken literally, and a base URL of another scheme than `file:`
 * keeps its scheme, host and user information.
 */
export function resolvePath(path: string, base?: string | URL): URL {
  const baseUrl = base ? new URL('.', base) : undefined

  if (baseUrl && baseUrl.protocol !== 'file:') {
    const url = new URL(baseUrl)
    const segments = path.split('/').filter(Boolean).map(encodeSegment)
    const from = path.startsWith('/') ? '/' : baseUrl.pathname
    url.pathname = posix.resolve(from, ...segments)
    return url
  }

  if (process.platform === 'win32' && driveRelative.test(path)) {
    throw new TypeError(`expected an absolute path, got the drive-relative form ${JSON.stringify(path)}`)
  }

  const resolved = baseUrl ? resolveNative(fileURLToPath(baseUrl), path) : resolveNative(path)
  return pathToFileURL(resolved)
}
