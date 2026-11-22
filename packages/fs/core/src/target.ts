import type { Stats } from './entry.ts'
import { FsError } from './error.ts'
import type { FsProvider } from './index.ts'
import { encodeName, resolvePath } from './path.ts'

const MAX_LINKS = 40

function containingDirectory(entry: URL) {
  const parent = new URL(entry)
  parent.pathname = entry.pathname.slice(0, entry.pathname.lastIndexOf('/') + 1) || '/'
  return parent
}

// On Windows, a drive or UNC share is the root for both ".." and rooted targets.
function rootOf(url: URL, windows: boolean) {
  const root = new URL(url)
  const volume = windows && (url.host ? /^\/[^/]+/.exec(url.pathname) : /^\/[a-z]:/i.exec(url.pathname))
  root.pathname = (volume ? volume[0] : '') + '/'
  return root
}

// Keep ".." and the directory requirement of a trailing separator or ".".
function linkParts(target: string, parent: URL, windows: boolean) {
  let path = target
  let root: URL | undefined
  if (windows) {
    path = path.replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\/(?=[a-z]:\/)/i, '')
    const volume = /^(?:\/\/[^/]+\/[^/]+|[a-z]:)(?=\/|$)/i.exec(path)
    if (/^[a-z]:(?!\/)/i.test(path)) throw new FsError('InvalidPath', parent, `drive-relative link target ${target}`)
    if (volume) {
      root = resolvePath(volume[0] + '/', parent)
      path = path.slice(volume[0].length)
    }
  }
  if (!root && path.startsWith('/')) root = rootOf(parent, windows)
  const components = path.split('/')
  const names = components.filter(name => name && name !== '.').map((name) => {
    // The file URL parser otherwise reads a literal "C|" at the root as "C:".
    if (parent.protocol === 'file:' && /^[a-z]\|$/i.test(name)) return name[0] + '%7C'
    return encodeName(name)
  })
  if (['', '.'].includes(components.at(-1)!)) names.push('.')
  return { root, names }
}

async function lookup(url: URL, provider: FsProvider, leaf: boolean): Promise<{ stats?: Stats, link?: string }> {
  try {
    const stats = await provider.stat?.(url, { follow: false })
    if (stats && stats.type !== 'symlink') return { stats }
    if (provider.readlink) return { link: await provider.readlink(url) }
    if (stats) throw new FsError('NotSupported', url, `cannot read a symbolic link at ${url.href}`)
  } catch (error) {
    if (!(error instanceof FsError) || !(error.code === 'NotALink' || leaf && error.code === 'NotFound')) throw error
  }
  return {}
}

// Resolve the file a write addresses. Only its final component may be missing.
export async function fileTarget(
  url: URL, { prefix, provider }: { prefix: string, provider: FsProvider },
  prefixes: Iterable<string>, owns: (url: URL) => boolean,
) {
  if (!URL.canParse('.', url)) throw new FsError('NotSupported', url, `cannot resolve a file target at ${url.href}`)
  if (url.pathname.endsWith('/')) return { url }
  if (!provider.readlink) return { url, ...await lookup(url, provider, true) }

  const windows = url.protocol === 'file:' && typeof process !== 'undefined' && process.platform === 'win32'
  const root = rootOf(url, windows)
  // A POSIX link stays on its host. A Windows file link can name another drive or UNC share.
  const scope = windows ? url.protocol : root.href
  // A directory link can escape a path mount or enter a mount nested in this scope.
  const checkParents = !scope.startsWith(prefix)
    || Array.from(prefixes).some(key => key !== prefix && key.startsWith(scope))
  const outside = (next: URL) => new FsError('CrossesDevices', url, `cannot publish through ${url.href} into another mount at ${next.href}`)
  // A path mount owns its subtree. Start absolute lookups at that boundary.
  function absolute(root: URL, names: string[]) {
    if (!owns(root)) {
      if (!prefix.startsWith(root.href)) throw outside(root)
      const mountNames = prefix.slice(root.href.length, -1).split('/')
      if (!mountNames.every((name, i) => names[i] === name)) throw outside(root)
      return { parent: new URL(prefix), names: names.slice(mountNames.length) }
    }
    return { parent: root, names }
  }

  let { parent, names } = checkParents
    ? absolute(root, url.pathname.slice(root.pathname.length).split('/'))
    : { parent: containingDirectory(url), names: [url.pathname.slice(url.pathname.lastIndexOf('/') + 1)] }
  const inspected = new Map<string, Awaited<ReturnType<typeof lookup>>>()
  let links = 0
  while (names.length) {
    const name = names.shift()!
    if (!name || name === '.') continue
    if (name === '..') {
      if (parent.href !== rootOf(parent, windows).href) {
        // The directory being left may itself be a link. Resolve that component
        // before discarding its name, even when it was in the caller's path.
        const entry = new URL(parent.href.slice(0, -1))
        const known = inspected.get(entry.href)
        parent = containingDirectory(entry)
        if (!checkParents && (!known || known.link !== undefined)) {
          names.unshift(entry.pathname.slice(entry.pathname.lastIndexOf('/') + 1), '..')
          continue
        }
      }
      if (!owns(parent)) throw outside(parent)
      continue
    }
    const next = new URL('./' + name, parent)
    if (!owns(next)) throw outside(next)
    // The provider traverses ordinary intermediate directories in its final lookup.
    if (!checkParents && names.length && names[0] !== '..' && names[0] !== '.') {
      parent = new URL(next.href + '/')
      continue
    }
    let info = inspected.get(next.href)
    if (!info) {
      info = await lookup(next, provider, !names.length)
      inspected.set(next.href, info)
    }
    const { link, stats } = info
    if (link !== undefined) {
      if (++links > MAX_LINKS) throw new FsError('InvalidPath', url, `too many symbolic links at ${url.href}`)
      const target = linkParts(link, parent, windows)
      const relative = target.root ? absolute(target.root, target.names) : { parent, names: target.names }
      parent = relative.parent
      names = relative.names.concat(names)
    } else {
      if (!names.length) return { url: next, stats }
      parent = new URL(next.href + '/')
      if (stats && stats.type !== 'directory') throw new FsError('NotADirectory', next, `expected a directory at ${next.href}`)
      // Without metadata, a trailing separator still requires a directory before "." or "..".
      if (!stats && (names[0] === '.' || names[0] === '..')) await lookup(parent, provider, false)
    }
  }
  return { url: parent }
}
