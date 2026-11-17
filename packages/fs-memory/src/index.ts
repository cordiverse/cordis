import { AccessMode, createFilter, FsError, FsProvider, Watcher } from '@cordisjs/fs'
import { Context } from 'cordis'

interface File {
  type: 'file'
  content: Uint8Array
}

interface Directory {
  type: 'directory'
  children: Map<string, Entry>
}

type Entry = File | Directory

/** A location: the root of its URL and the decoded names below it. */
interface Location {
  url: URL
  /** the URL without its path, such as `memory://app`; each root is a directory of its own */
  root: string
  names: string[]
  /** whether the URL ends with a separator, which names a directory */
  directory: boolean
}

// the result of a lookup: the entry at the location, if any, and its parent directory
interface Lookup {
  parent?: Directory
  name?: string
  entry?: Entry
}

interface Subscription {
  watcher: Watcher
  location: Location
  keep?: (path: string, isDirectory: boolean) => boolean
}

function invalid(url: URL, message: string, cause?: unknown) {
  return new FsError('InvalidPath', url, message, { cause })
}

function locate(url: URL): Location {
  const { href, protocol, pathname } = url
  // a URL with an opaque path, such as `memory:a.txt`, names no hierarchy
  if (!pathname.startsWith('/') && !href.startsWith(protocol + '//')) {
    throw invalid(url, `expected a URL with a hierarchical path, got ${JSON.stringify(href)}`)
  }
  if (url.search || url.hash || href.endsWith('?') || href.endsWith('#')) {
    throw invalid(url, `expected a URL without a query or fragment, got ${JSON.stringify(href)}`)
  }
  const names: string[] = []
  // empty segments are removed, as by a POSIX path resolution
  for (const segment of pathname.split('/')) {
    if (!segment) continue
    if (/%2f/i.test(segment)) {
      throw invalid(url, `expected a URL without an encoded separator, got ${JSON.stringify(href)}`)
    }
    let name: string
    try {
      name = decodeURIComponent(segment)
    } catch (error) {
      throw invalid(url, `invalid percent-encoding in ${JSON.stringify(href)}`, error)
    }
    names.push(name)
  }
  return {
    url,
    root: href.slice(0, href.length - pathname.length),
    names,
    directory: pathname.endsWith('/'),
  }
}

// The URL of a location, as reported by a watch. A name is percent-encoded
// where the URL parser would change it: `%`, `?`, `#` and `\` end a segment,
// and the parser removes controls and spaces at the ends of the input, and
// tabs and newlines anywhere.
function format(root: string, names: string[]) {
  const path = names.map(name => name.replace(/[\x00-\x20%?#\\]/g, (char) => {
    return '%' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
  }))
  return new URL(root + '/' + path.join('/'))
}

// the locations that a mount serves, as `ctx.fs.mount()` routes them
interface Scope {
  /**
   * The base of the keys of the top level of `files`: the mount, or
   * `<scheme>:///` for a mount at a scheme. Absent for the empty string and
   * for a scheme whose URLs require a host, such as `https:`.
   */
  base?: URL
  contains(url: URL): boolean
}

function toScope(mount: string): Scope {
  if (mount === '') return { contains: () => true }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:$/.test(mount)) {
    const protocol = mount.toLowerCase()
    const contains = (url: URL) => url.protocol === protocol
    try {
      return { base: new URL(protocol + '///'), contains }
    } catch {
      return { contains }
    }
  }
  try {
    const { href } = new URL(mount)
    const prefix = href.endsWith('/') ? href : href + '/'
    return { base: new URL(prefix), contains: url => url.href.startsWith(prefix) || url.href + '/' === prefix }
  } catch (error) {
    throw new TypeError(`expected a scheme or a URL as the mount, got ${JSON.stringify(mount)}`, { cause: error })
  }
}

// whether `names` lies below `base`, or is `base` itself
function startsWith(names: string[], base: string[]) {
  return base.length <= names.length && base.every((name, index) => names[index] === name)
}

// A copy of `content` with a buffer of its own. `slice()` of a `Buffer`
// would share the memory of the `Buffer`.
function toBytes(content: string | Uint8Array) {
  return typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content)
}

async function collect(body: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of body) {
    // copied at once, as the producer may reuse the memory of a chunk
    chunks.push(new Uint8Array(chunk))
    length += chunk.byteLength
  }
  const content = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    content.set(chunk, offset)
    offset += chunk.byteLength
  }
  return content
}

/**
 * A file system in memory, mounted at `config.mount`. Each root of a URL, such
 * as `memory://app` or `memory://`, is a directory that always exists.
 *
 * A read returns the content of the file when it is called, as one chunk. A
 * write replaces the content of a file at once, after its body is consumed, so
 * a read observes either the previous or the new content. A watch reports a
 * `change` synchronously with each write and rename that gives content to a
 * file at or below its location.
 *
 * A subclass can override the operations, e.g. to inject failures in tests.
 */
class MemoryFs implements FsProvider {
  static inject = ['fs']

  private _roots = new Map<string, Directory>()
  private _subscriptions = new Set<Subscription>()

  constructor(ctx: Context, config: MemoryFs.Config = {}) {
    const mount = config.mount ?? 'memory:'
    const scope = toScope(mount)
    this._populate(config.files ?? {}, scope, scope.base)
    ctx.fs.mount(mount, this)
  }

  private _populate(tree: MemoryFs.Tree, scope: Scope, base: URL | undefined) {
    for (const [key, value] of Object.entries(tree)) {
      let url: URL
      try {
        url = new URL(key, base)
      } catch (error) {
        // a key with a scheme is parsed as an absolute URL, whatever the base
        const message = base || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(key)
          ? `invalid URL ${JSON.stringify(key)}`
          : `expected an absolute URL as a key of the top level, as the mount has no base URL, got ${JSON.stringify(key)}`
        throw new TypeError(message, { cause: error })
      }
      if (!scope.contains(url)) {
        throw new TypeError(`expected a location of the mount, got ${JSON.stringify(key)} at ${url.href}`)
      }
      if (typeof value === 'string' || value instanceof Uint8Array) {
        const location = locate(url)
        const { parent, name, entry } = this._lookup(location, true)
        if (location.directory || !parent || entry?.type === 'directory') {
          throw new FsError('IsADirectory', url, `expected a file at ${url.href}`)
        }
        parent.children.set(name!, { type: 'file', content: toBytes(value) })
      } else {
        if (!url.pathname.endsWith('/')) url.pathname += '/'
        const location = locate(url)
        const { parent, name, entry } = this._lookup(location, true)
        if (entry?.type === 'file') throw new FsError('NotADirectory', url, `expected a directory at ${url.href}`)
        if (!entry) parent!.children.set(name!, { type: 'directory', children: new Map() })
        this._populate(value, scope, url)
      }
    }
  }

  /**
   * Find the entry at `location`. A missing parent directory fails with
   * `NotFound` unless `create` is set, and a parent that is a file fails with
   * `NotADirectory`.
   */
  private _lookup(location: Location, create = false): Lookup {
    let root = this._roots.get(location.root)
    if (!root) {
      root = { type: 'directory', children: new Map() }
      this._roots.set(location.root, root)
    }
    let directory: Directory = root
    const { names, url } = location
    if (!names.length) return { entry: directory }
    for (const name of names.slice(0, -1)) {
      let entry = directory.children.get(name)
      if (!entry && create) {
        entry = { type: 'directory', children: new Map() }
        directory.children.set(name, entry)
      }
      if (!entry) throw new FsError('NotFound', url, `no such file or directory: ${url.href}`)
      if (entry.type === 'file') throw new FsError('NotADirectory', url, `not a directory: ${url.href}`)
      directory = entry
    }
    const name = names[names.length - 1]
    return { parent: directory, name, entry: directory.children.get(name) }
  }

  // the existing entry at `location`, which is a directory if the location names one
  private _find(location: Location) {
    const lookup = this._lookup(location)
    const { url } = location
    if (!lookup.entry) throw new FsError('NotFound', url, `no such file or directory: ${url.href}`)
    if (location.directory && lookup.entry.type !== 'directory') {
      throw new FsError('NotADirectory', url, `not a directory: ${url.href}`)
    }
    return lookup as Lookup & { entry: Entry }
  }

  // the parent directory and the name of a file to be written at `location`
  private _target(location: Location) {
    const { url } = location
    const { parent, name, entry } = this._lookup(location)
    if (!parent || entry?.type === 'directory') {
      throw new FsError('IsADirectory', url, `is a directory: ${url.href}`)
    }
    return { parent, name: name! }
  }

  read(url: URL): ReadableStream<Uint8Array> {
    return new ReadableStream({
      // called synchronously, so that the stream has the content at the time of the call
      start: (controller) => {
        const location = locate(url)
        if (location.directory) throw new FsError('IsADirectory', url, `is a directory: ${url.href}`)
        const { entry } = this._find(location)
        if (entry.type === 'directory') throw new FsError('IsADirectory', url, `is a directory: ${url.href}`)
        // a copy, so that the reader cannot modify the stored content
        if (entry.content.byteLength) controller.enqueue(entry.content.slice())
        controller.close()
      },
    })
  }

  async write(url: URL, body: ReadableStream<Uint8Array>) {
    const location = locate(url)
    if (location.directory) throw new FsError('IsADirectory', url, `is a directory: ${url.href}`)
    this._target(location)
    // an error of `body` is kept as it is, and leaves the file unchanged
    const content = await collect(body)
    // the entries may have changed while `body` was consumed
    const { parent, name } = this._target(location)
    parent.children.set(name, { type: 'file', content })
    this._notify(location.root, location.names, false)
  }

  async access(url: URL, mode: AccessMode) {
    this._find(locate(url))
  }

  async rename(src: URL, dest: URL) {
    const from = locate(src)
    const to = locate(dest)
    const source = this._find(from)
    if (!source.parent) throw new FsError('PermissionDenied', src, `cannot rename the root ${src.href}`)
    const target = this._lookup(to)
    if (!target.parent) throw new FsError('PermissionDenied', dest, `cannot replace the root ${dest.href}`)
    if (to.directory && source.entry.type !== 'directory') {
      throw new FsError('NotADirectory', dest, `not a directory: ${dest.href}`)
    }
    if (source.entry === target.entry) return
    if (from.root === to.root && startsWith(to.names, from.names)) {
      throw new FsError('InvalidPath', dest, `cannot move ${src.href} into itself`)
    }
    if (target.entry) {
      if (source.entry.type === 'file' && target.entry.type === 'directory') {
        throw new FsError('IsADirectory', dest, `is a directory: ${dest.href}`)
      }
      if (source.entry.type === 'directory' && target.entry.type === 'file') {
        throw new FsError('NotADirectory', dest, `not a directory: ${dest.href}`)
      }
      if (target.entry.type === 'directory' && target.entry.children.size) {
        throw new FsError('DirectoryNotEmpty', dest, `directory not empty: ${dest.href}`)
      }
    }
    source.parent.children.delete(source.name!)
    target.parent.children.set(target.name!, source.entry)
    this._notifyTree(to.root, to.names, source.entry)
  }

  async remove(url: URL) {
    const location = locate(url)
    const { parent, name, entry } = this._find(location)
    if (!parent) throw new FsError('PermissionDenied', url, `cannot remove the root ${url.href}`)
    if (entry.type === 'directory' && entry.children.size) {
      throw new FsError('DirectoryNotEmpty', url, `directory not empty: ${url.href}`)
    }
    parent.children.delete(name!)
  }

  watch(watcher: Watcher) {
    const { filter } = watcher.options
    const subscription: Subscription = {
      watcher,
      location: locate(watcher.url),
      keep: filter && createFilter(filter),
    }
    this._subscriptions.add(subscription)
    watcher.emit('ready')
    return () => {
      this._subscriptions.delete(subscription)
    }
  }

  // reports a change of each file of `entry`, which is placed at `names`
  private _notifyTree(root: string, names: string[], entry: Entry) {
    if (entry.type === 'file') return this._notify(root, names, false)
    for (const [name, child] of entry.children) {
      this._notifyTree(root, [...names, name], child)
    }
  }

  private _notify(root: string, names: string[], isDirectory: boolean) {
    let url: URL | undefined
    for (const { watcher, location, keep } of [...this._subscriptions]) {
      if (location.root !== root || !startsWith(names, location.names)) continue
      if (keep) {
        try {
          // a directory excluded by `filter` excludes the entries below it
          const base = location.names.length
          let kept = true
          for (let end = base + 1; kept && end <= names.length; end++) {
            kept = keep(names.slice(base, end).join('/'), end < names.length || isDirectory)
          }
          if (!kept) continue
        } catch (error) {
          watcher.emit('error', error)
          continue
        }
      }
      watcher.emit('change', url ??= format(root, names))
    }
  }
}

namespace MemoryFs {
  /**
   * A tree of entries. A string or a `Uint8Array` is the content of a file,
   * and an object is a directory; missing parent directories are created.
   *
   * Each key is a URL reference, resolved against the directory of its
   * parent, or at the top level against the mount (`<scheme>:///` for a mount
   * at a scheme). At the top level of a mount at the empty string, or at a
   * scheme whose URLs require a host, such as `https:`, a key is an absolute
   * URL. A key outside the mount fails.
   */
  export interface Tree {
    [key: string]: string | Uint8Array | Tree
  }

  export interface Config {
    /** a scheme, a URL, or the empty string for every location; `memory:` by default */
    mount?: string
    /** the initial entries */
    files?: Tree
  }
}

export default MemoryFs
