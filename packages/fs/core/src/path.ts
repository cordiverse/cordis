import { FsError } from './error.ts'

/**
 * A location given to `@cordisjs/fs`. A `URL` is taken as it is. A string
 * with a scheme of at least two characters, such as `memory:`, is an absolute
 * URL. Any other string is a path, and an array is a list of names; both are
 * resolved against a base URL, which names a directory.
 *
 * In a path, `/` and `\` separate the names, `.` and `..` name the directory
 * and its parent, a leading separator starts at the root of the base URL, and
 * a trailing separator names a directory. Two leading separators followed by
 * a host, such as `\\server\share`, start a path on that host with the scheme
 * of the base URL. A drive letter followed by a separator, such as `C:\app`,
 * starts an absolute path whose first name is the drive, on the local host
 * for a file URL. Every other character is a literal part of a name, `%`,
 * `#`, `?` and spaces included.
 *
 * In an array, every element is a literal name, `\` included. An empty
 * element, `.`, `..`, or an element with `/` cannot name an entry, and fails
 * with `InvalidPath`.
 */
export type Path = string | readonly string[] | URL

const scheme = /^[a-zA-Z][a-zA-Z\d+.-]+:/

const drive = /^[a-zA-Z]:[\\/]/

// A name as a segment of a URL path. The characters that the URL parser would
// change are percent-encoded: `%`, `?`, `#` and `\` end a segment or escape,
// and the parser removes controls and spaces at the ends of the input, and
// tabs and newlines anywhere.
function encodeName(name: string) {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x20%?#\\]/g, (char) => {
    return '%' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
  })
}

function invalid(path: Path, message: string, cause?: unknown) {
  return new FsError('InvalidPath', undefined, `${message}, got ${JSON.stringify(path)}`, { cause })
}

// the directory named by `base`, without its query and fragment
function toBase(base: URL) {
  const url = new URL(base)
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

// A file URL reads a first segment such as `C|` as the drive `C:`. Whether
// the segment is first, after the base directory and any preceding `..`, is
// left to the URL parser.
function toSegments(names: readonly string[], prefix: string, base: URL) {
  const segments: string[] = []
  for (const name of names) {
    if (name === '' || name === '.') continue
    let encoded = encodeName(name)
    if (base.protocol === 'file:' && /^[a-zA-Z]\|$/.test(name) && (!segments.length || segments.at(-1) === '..')) {
      const url = new URL(prefix + [...segments, name].join('/'), base)
      if (url.pathname === '/' + name[0] + ':') encoded = name[0] + '%7C'
    }
    segments.push(encoded)
  }
  return segments
}

// the reference of a path, relative to `base`, to its root, or to a host
function toReference(path: string, base: URL) {
  let prefix = './'
  const network = /^[\\/]{2}([^\\/]+)/.exec(path)
  if (network) {
    // the host is parsed as a part of the URL
    prefix = '//' + network[1] + '/'
    path = path.slice(network[0].length)
  } else if (drive.test(path)) {
    // a drive is local, also below a base URL with a host
    prefix = base.protocol === 'file:' ? '///' : '/'
  } else if (/^[\\/]/.test(path)) {
    prefix = '/'
  }
  const names = path.split(/[\\/]/)
  const segments = toSegments(names, prefix, base)
  // a trailing separator, `.` or `..` names a directory
  const last = names[names.length - 1]
  const directory = segments.length && (last === '' || last === '.' || last === '..')
  return prefix + segments.join('/') + (directory ? '/' : '')
}

/** Whether a string of `Path` is an absolute URL, which needs no base URL. */
export function isUrl(path: string) {
  return scheme.test(path)
}

// A path or an array requires `base`.
export function resolvePath(path: Path, base: URL | undefined): URL {
  if (path instanceof URL) return path
  if (typeof path === 'string' && isUrl(path)) {
    try {
      return new URL(path)
    } catch (error) {
      throw invalid(path, 'expected a valid URL', error)
    }
  }
  if (!base) throw invalid(path, 'expected an absolute URL without a base URL')
  if (typeof path !== 'string') {
    for (const name of path) {
      if (!name || name === '.' || name === '..' || name.includes('/')) {
        throw invalid(path, 'expected names of entries')
      }
    }
  }
  try {
    const directory = toBase(base)
    const reference = typeof path === 'string'
      ? toReference(path, directory)
      : './' + toSegments(path, './', directory).join('/')
    return new URL(reference, directory)
  } catch (error) {
    throw invalid(path, 'expected a base URL with a hierarchical path', error)
  }
}

// Fails on a URL with a hierarchical path that is not a location, which
// leaves a provider to decode each segment of the path as a name.
export function assertLocation(url: URL) {
  const { href, protocol, pathname } = url
  if (!pathname.startsWith('/') && !href.startsWith(protocol + '//')) return
  if (url.search || url.hash || href.endsWith('?') || href.endsWith('#')) {
    throw new FsError('InvalidPath', url, `expected a location without a query or fragment, got ${href}`)
  }
  for (const segment of pathname.split('/')) {
    if (/%2f/i.test(segment)) {
      throw new FsError('InvalidPath', url, `expected a location without an encoded separator, got ${href}`)
    }
    try {
      decodeURIComponent(segment)
    } catch (error) {
      throw new FsError('InvalidPath', url, `invalid percent-encoding in ${href}`, { cause: error })
    }
  }
}

// Whether `url` has a hierarchical path, in which a trailing separator names a
// directory. At a location without one, it may be a part of the name.
export function isHierarchical(url: URL) {
  return URL.canParse('.', url)
}
