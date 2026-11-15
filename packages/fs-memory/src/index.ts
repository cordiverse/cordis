import { AccessMode, createFilter, FsError, FsProvider, Watcher } from '@cordisjs/fs'
import { Awaitable } from 'cosmokit'
import { Context } from 'cordis'

/** An operation of `FsProvider` on a location, as passed to `Volume.Options.hook`. */
export type Operation = 'read' | 'write' | 'access' | 'rename' | 'remove'

interface File {
  type: 'file'
  /** replaced by each write and never modified, so that a read keeps the content it started with */
  content: Uint8Array
}

interface Directory {
  type: 'directory'
  children: Map<string, Entry>
}

type Entry = File | Directory

/** A location of the volume: the root of its URL and the decoded names below it. */
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

const CHUNK_SIZE = 64 * 1024

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

// The URL of a location as reported by a watch. The characters that the URL
// parser does not encode, but that end a path or a segment, are encoded.
function format(root: string, names: string[]) {
  const path = names.map(name => name.replace(/[%?#\\]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()))
  return new URL(root + '/' + path.join('/'))
}

// whether `names` lies below `base`, or is `base` itself
function startsWith(names: string[], base: string[]) {
  return base.length <= names.length && base.every((name, index) => names[index] === name)
}

function toBytes(content: string | Uint8Array) {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content.slice()
}

async function collect(body: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of body) {
    chunks.push(chunk)
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
 * A file system in memory, which can be mounted at any prefix. Each root of a
 * URL, such as `memory://app` or `memory://`, is a directory that always exists.
 *
 * A write replaces the content of a file at once, after its body is consumed,
 * so a read observes either the previous or the new content. A watch reports a
 * `change` synchronously with each write and rename that gives content to a
 * file at or below its location.
 */
export class Volume implements FsProvider {
  private _roots = new Map<string, Directory>()
  private _subscriptions = new Set<Subscription>()

  /**
   * `files` is a tree of initial entries. Each key is a URL reference,
   * resolved against the directory of its parent; a key of the top level is
   * an absolute URL. A string or a `Uint8Array` is the content of a file, and
   * an object is a directory. Missing parent directories are created.
   */
  constructor(files: Volume.Tree = {}, public options: Volume.Options = {}) {
    this._populate(files)
  }

  private _populate(tree: Volume.Tree, base?: URL) {
    for (const [key, value] of Object.entries(tree)) {
      let url: URL
      try {
        url = new URL(key, base)
      } catch (error) {
        throw new TypeError(`invalid location ${JSON.stringify(key)}`, { cause: error })
      }
      if (typeof value === 'string' || value instanceof Uint8Array) {
        const location = locate(url)
        if (location.directory) throw new FsError('IsADirectory', url, `expected a file at ${url.href}`)
        const { parent, name, entry } = this._lookup(location, true)
        if (!parent) throw new FsError('IsADirectory', url, `expected a file at ${url.href}`)
        if (entry?.type === 'directory') throw new FsError('IsADirectory', url, `expected a file at ${url.href}`)
        parent.children.set(name!, { type: 'file', content: toBytes(value) })
      } else {
        if (!url.pathname.endsWith('/')) url.pathname += '/'
        const location = locate(url)
        const { parent, name, entry } = this._lookup(location, true)
        if (entry?.type === 'file') throw new FsError('NotADirectory', url, `expected a directory at ${url.href}`)
        if (!entry) parent!.children.set(name!, { type: 'directory', children: new Map() })
        this._populate(value, url)
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

  private async _hook(operation: Operation, url: URL) {
    await this.options.hook?.(operation, url)
  }

  read(url: URL): ReadableStream<Uint8Array> {
    const chunkSize = this.options.chunkSize ?? CHUNK_SIZE
    let content: Uint8Array
    let offset = 0
    return new ReadableStream({
      start: async () => {
        const location = locate(url)
        if (location.directory) throw new FsError('IsADirectory', url, `is a directory: ${url.href}`)
        await this._hook('read', url)
        const { entry } = this._find(location)
        if (entry.type === 'directory') throw new FsError('IsADirectory', url, `is a directory: ${url.href}`)
        content = entry.content
      },
      pull: (controller) => {
        if (offset >= content.byteLength) return controller.close()
        // a copy, so that the reader cannot modify the stored content
        controller.enqueue(content.slice(offset, offset += chunkSize))
      },
    }, { highWaterMark: 0 })
  }

  async write(url: URL, body: ReadableStream<Uint8Array>) {
    const location = locate(url)
    if (location.directory) throw new FsError('IsADirectory', url, `is a directory: ${url.href}`)
    await this._hook('write', url)
    this._target(location)
    // an error of `body` is kept as it is, and leaves the file unchanged
    const content = await collect(body)
    // the entries may have changed while `body` was consumed
    const { parent, name } = this._target(location)
    parent.children.set(name, { type: 'file', content })
    this._notify(location.root, location.names, false)
  }

  async access(url: URL, mode: AccessMode) {
    const location = locate(url)
    await this._hook('access', url)
    this._find(location)
  }

  async rename(src: URL, dest: URL) {
    const from = locate(src)
    const to = locate(dest)
    await this._hook('rename', src)
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
    await this._hook('remove', url)
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

export namespace Volume {
  export interface Tree {
    [key: string]: string | Uint8Array | Tree
  }

  export interface Options {
    /** the size of the chunks of a read stream, 64 KiB by default */
    chunkSize?: number
    /**
     * Called before each operation with its location, the source for a
     * rename. An error thrown or a rejection fails the operation with it, so a
     * test can inject failures and delays.
     */
    hook?: (operation: Operation, url: URL) => Awaitable<void>
  }
}

/** Mounts a `Volume` at `config.mount`. */
class MemoryFs {
  static inject = ['fs']

  public volume: Volume

  constructor(ctx: Context, config: MemoryFs.Config = {}) {
    this.volume = new Volume(config.files)
    ctx.fs.mount(config.mount ?? 'memory:', this.volume)
  }
}

namespace MemoryFs {
  export interface Config {
    /** a scheme or a URL ending with `/`, `memory:` by default */
    mount?: string
    /** the initial entries, as `files` of `Volume` */
    files?: Volume.Tree
  }
}

export default MemoryFs
