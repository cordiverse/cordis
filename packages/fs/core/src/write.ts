import type { Stats } from './entry.ts'
import { FsError } from './error.ts'
import type { FsProvider } from './index.ts'
import { isHierarchical } from './path.ts'

// The name of a temporary file, by which a watch recognizes the events of
// one, also those reported after the write or caused by another process.
const pattern = /^\.cordis-[0-9a-f]{12}\.tmp$/i

export function isTemporaryFile(name: string): boolean {
  return pattern.test(name)
}

// A random name beside `url`, other than `occupied` and than the name of
// `url`, also as Windows compares names, ignoring case and trailing dots.
function temporaryUrl(url: URL, occupied?: URL): URL {
  const leaf = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1)).replace(/[. ]+$/, '').toLowerCase()
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  let id = bytes.reduce((value, byte) => value * 256 + byte, 0)
  for (;;) {
    const name = `.cordis-${id.toString(16).padStart(12, '0')}.tmp`
    const candidate = new URL(name, url)
    if (name !== leaf && candidate.href !== occupied?.href) return candidate
    id = (id + 1) % 2 ** 48
  }
}

// The attempts of an operation to create a temporary file, which retries an occupied name once.
interface Attempts {
  retried?: boolean
}

/**
 * Creates a temporary file beside `dest` by `create`, which creates the file
 * at the given location exclusively, and returns its location. An
 * `AlreadyExists` of that location is retried under another name, once for
 * all `attempts` of an operation; another failure is thrown as it is.
 */
export async function createTemporary(
  dest: URL, owns: (url: URL) => boolean, create: (url: URL) => Promise<void>, attempts: Attempts = {},
) {
  let url = temporaryUrl(dest)
  while (true) {
    if (!owns(url)) throw new FsError('NotSupported', dest, `cannot stage a file in the mount of ${dest.href}`)
    try {
      await create(url)
      return url
    } catch (error) {
      if (attempts.retried || !(error instanceof FsError) || error.code !== 'AlreadyExists' || error.url?.href !== url.href) throw error
      attempts.retried = true
      url = temporaryUrl(dest, url)
    }
  }
}

// Creates an empty temporary file beside `dest`, before content that cannot
// be read again is transferred into it, and returns it with the mode to give
// the content. A known mode is given by the transfer, so the empty file is private.
export async function reserveFile(
  dest: URL, provider: FsProvider & Required<Pick<FsProvider, 'write' | 'remove'>>,
  owns: (url: URL) => boolean, mode?: number,
) {
  const attempts: Attempts = {}
  const empty = (privateFile: boolean) => (url: URL) => provider.write(url, new Blob([]).stream(),
    privateFile ? { exclusive: true, mode: 0o600 } : { exclusive: true })
  let url = await createTemporary(dest, owns, empty(mode !== undefined), attempts)
  if (mode !== undefined || !provider.stat) return { url, mode }

  // A default mode such as 0444 permits the creation, but not another opening
  // for the transfer. It is given to the content, and the empty file is
  // created again as a private one.
  const stats = await provider.stat(url, { follow: false }).catch(() => undefined)
  if (stats?.mode === undefined || (stats.mode & 0o200)) return { url, mode }
  try {
    await provider.remove(url, { recursive: false })
  } catch (error) {
    if (error instanceof FsError && error.code === 'NotFound') throw error
    // An ambiguous failure can arrive after removal. Check the entry's identity
    // when available. Otherwise retry cleanup only after an explicit refusal.
    let retained = error instanceof FsError && (error.code === 'Busy' || error.code === 'PermissionDenied')
    if (stats.ino !== undefined) {
      const entry = await provider.stat(url, { follow: false }).catch(() => undefined)
      retained = entry?.ino === stats.ino && entry.dev === stats.dev
    }
    if (retained) await provider.remove(url, { recursive: false }).catch(() => {})
    throw error
  }
  url = await createTemporary(dest, owns, empty(true), attempts)
  return { url, mode: stats.mode }
}

// The metadata of the entry at `url` itself, or `undefined` for a missing one.
async function lstat(url: URL, provider: FsProvider): Promise<Stats | undefined> {
  try {
    return await provider.stat?.(url, { follow: false })
  } catch (error) {
    if (!(error instanceof FsError) || error.code !== 'NotFound') throw error
  }
}

/**
 * The file that a write to `url` gives content to, with its metadata if it
 * exists. With `realpath()`, the provider resolves the links, also a dangling
 * one in the last component; without it, `url` is the file. The file has to
 * be a location of the same mount. Unless the mount is the only one and at
 * the empty prefix, a link in a parent directory may lead out of it, so that
 * the whole location is resolved; otherwise, only the last component is.
 * A file to be `staged`, with a temporary file beside it, has to be at a
 * location with a hierarchical path.
 */
export async function fileTarget(
  url: URL, { prefix, provider }: { prefix: string, provider: FsProvider },
  mounts: number, owns: (url: URL) => boolean, staged: boolean,
): Promise<{ url: URL, stats?: Stats }> {
  // checked before the metadata of the file is queried
  function assertStageable(dest: URL) {
    if (staged && !isHierarchical(dest)) throw new FsError('NotSupported', url, `cannot stage a file beside ${dest.href}`)
  }

  if (isHierarchical(url) && url.pathname.endsWith('/')) return { url }
  if (!provider.realpath) {
    assertStageable(url)
    return { url, stats: await lstat(url, provider) }
  }

  const atPath = prefix !== '' && !prefix.endsWith(':')
  const boundary = isHierarchical(url) ? atPath ? prefix : new URL('/', url).href : undefined
  const parents = !!boundary && url.href.slice(boundary.length).includes('/')
  if (!(parents && (prefix !== '' || mounts > 1)) && provider.stat) {
    const stats = await lstat(url, provider)
    if (stats?.type !== 'symlink') {
      assertStageable(url)
      return { url, stats }
    }
  }

  let dest = await provider.realpath(url)
  // A mount at a path below the root names its locations through the path of
  // its prefix, which the storage may resolve to another path.
  if (!owns(dest) && atPath && new URL(prefix).pathname !== '/') {
    const base = (await provider.realpath(new URL(prefix))).href.replace(/\/$/, '')
    if (dest.href === base) dest = new URL(prefix)
    else if (dest.href.startsWith(base + '/')) dest = new URL(prefix + dest.href.slice(base.length + 1))
  }
  if (!owns(dest)) {
    throw new FsError('CrossesDevices', url, `cannot write through ${url.href} into another mount at ${dest.href}`)
  }
  if (isHierarchical(dest) && dest.pathname.endsWith('/')) return { url: dest }
  assertStageable(dest)
  return { url: dest, stats: await lstat(dest, provider) }
}
