import { Context, Service } from 'cordis'
import { Awaitable } from 'cosmokit'
import { pathToFileURL } from 'node:url'
import { CopyOptions, DirEntry, EntryType, entryUrl, MkdirOptions, RemoveOptions, StatOptions, Stats } from './entry.ts'
import { FsError } from './error.ts'
import { FileRef } from './file.ts'
import { Watcher, WatchOptions } from './watcher.ts'

export * from './entry.ts'
export * from './error.ts'
export * from './file.ts'
export * from './filter.ts'
export * from './watcher.ts'

declare module 'cordis' {
  interface Context {
    fs: Fs
  }
}

interface Mount {
  /** a scheme such as `s3:`, a URL ending with `/`, or the empty string for every location */
  prefix: string
  provider: FsProvider
}

// a watch served by the provider of a mount
interface Connection {
  mount: Mount
  dispose: () => Awaitable<void>
}

export type AccessMode = 'write'

const accessModes: readonly string[] = ['write'] satisfies AccessMode[]

function normalizePrefix(prefix: string | URL) {
  if (prefix === '') return ''
  if (typeof prefix === 'string' && /^[a-zA-Z][a-zA-Z\d+.-]*:$/.test(prefix)) {
    return prefix.toLowerCase()
  }
  const { href } = new URL(prefix)
  return href.endsWith('/') ? href : href + '/'
}

// A Windows drive-letter path, e.g. `C:\app` or `C:/app`.
const driveLetter = /^[A-Za-z]:[\\/]/

// On Windows, a drive-letter path is a file path, which `new URL()` would read
// as a URL of the scheme `c:`.
function toReference(path: string) {
  if (typeof process === 'undefined' || process.platform !== 'win32' || !driveLetter.test(path)) return path
  return pathToFileURL(path).href
}

// the working directory as a URL, on a runtime that has one
function getWorkingDirectory() {
  if (typeof process === 'undefined') return
  return pathToFileURL(process.cwd()).href
}

// A base URL names a directory, and has no query or fragment. A URL with an
// opaque path, such as `mem:bucket/`, cannot resolve a relative reference.
function toDirectory(url: URL, input: string) {
  try {
    new URL('.', url)
  } catch (error) {
    throw new TypeError(`expected a base URL without an opaque path, got ${JSON.stringify(input)}`, { cause: error })
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  url.search = ''
  url.hash = ''
  return url
}

// the URL without its query, its fragment and its trailing separators
function toKey(url: URL) {
  return url.href.slice(0, url.href.length - url.hash.length - url.search.length).replace(/\/+$/, '')
}

// whether `url` is `base` or lies below it, compared by the URLs alone
function contains(base: URL, url: URL) {
  const prefix = toKey(base)
  const key = toKey(url)
  return key === prefix || key.startsWith(prefix + '/')
}

// A stream of the same chunks as `stream`, whose first chunk has been read,
// so that a failure to open the source is reported before it is consumed.
async function primed(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const first = await reader.read()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done) return controller.close()
      controller.enqueue(first.value)
    },
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) return controller.close()
      controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  }, { highWaterMark: 0 })
}

/**
 * The file system service, which forwards each operation to the provider
 * mounted at its location.
 */
export class Fs extends Service<Fs.Intercept> {
  private _mounts = new Map<string, Mount>()
  /** the connection that serves each watch, if any */
  private _watchers = new Map<Watcher, Connection | undefined>()
  public config: Required<Fs.Config>

  constructor(ctx: Context, config: Fs.Config = {}) {
    super(ctx, 'fs')
    const baseUrl = config.baseUrl ?? getWorkingDirectory()
    if (baseUrl === undefined) {
      throw new TypeError('expected `baseUrl` on a runtime without a working directory')
    }
    let url: URL
    try {
      url = new URL(toReference(baseUrl))
    } catch (error) {
      throw new TypeError(`expected an absolute base URL, got ${JSON.stringify(baseUrl)}`, { cause: error })
    }
    this.config = { ...config, baseUrl: toDirectory(url, baseUrl).href }
  }

  /**
   * The base URL of relative references, which names a directory: its path
   * ends with `/`, and it has no query or fragment. The `baseUrl` of the
   * config is followed by that of each intercept, from the outermost to the
   * innermost, which is resolved against the result of the preceding ones.
   */
  get baseUrl(): URL {
    return new URL(this[Service.resolveIntercept]().baseUrl!)
  }

  [Service.mergeIntercept](...values: Fs.Intercept[]): Fs.Intercept {
    let baseUrl = this.config.baseUrl
    for (const value of values) {
      if (value?.baseUrl === undefined) continue
      let url: URL
      try {
        url = new URL(toReference(value.baseUrl), baseUrl)
      } catch (error) {
        throw new TypeError(`invalid base URL ${JSON.stringify(value.baseUrl)}`, { cause: error })
      }
      baseUrl = toDirectory(url, value.baseUrl).href
    }
    return { ...Object.assign({}, ...values), baseUrl }
  }

  /**
   * Mount a provider at a scheme, such as `s3:`, at a URL, such as
   * `file:///`, or at the empty string, which contains every location. A
   * location goes to the provider of the longest prefix that contains it, so a
   * provider at the empty string serves the locations of no other mount, and
   * no location fails with `NoProvider` while it is mounted. The mount ends
   * with the calling fiber.
   *
   * Every watch follows the routing: a change of the mounts moves it to the
   * provider its location goes to, and a watch without a provider is resumed
   * once one is mounted. Changes while a watch has no provider are not reported.
   */
  mount(prefix: string | URL, provider: FsProvider) {
    const key = normalizePrefix(prefix)
    return this.ctx.effect(() => {
      if (this._mounts.has(key)) {
        throw new Error(`a provider is already mounted at ${key}`)
      }
      this._mounts.set(key, { prefix: key, provider })
      this._reroute()
      return () => {
        this._mounts.delete(key)
        return this._reroute()
      }
    }, 'ctx.fs.mount()')
  }

  /**
   * Resolve a URL reference against `baseUrl`. On Windows, a drive-letter
   * path, such as `C:\app`, is taken as a file path. A reference that cannot be
   * parsed throws an `FsError` with the code `InvalidPath`.
   */
  resolve(path: string | URL): URL {
    if (path instanceof URL) return path
    const base = this.baseUrl
    try {
      return new URL(toReference(path), base)
    } catch (error) {
      throw new FsError('InvalidPath', undefined, `invalid URL ${JSON.stringify(path)}`, { cause: error })
    }
  }

  private _match(url: URL): Mount | undefined {
    let result: Mount | undefined
    for (const mount of this._mounts.values()) {
      const matches = mount.prefix.endsWith(':')
        ? url.protocol === mount.prefix
        : url.href.startsWith(mount.prefix) || url.href + '/' === mount.prefix
      if (matches && (!result || mount.prefix.length > result.prefix.length)) result = mount
    }
    return result
  }

  private _route(url: URL): Mount {
    const mount = this._match(url)
    if (!mount) throw new FsError('NoProvider', url, `no provider is mounted for ${url.href}`)
    return mount
  }

  private _provider<K extends Operation>(url: URL, name: K, mount = this._route(url)) {
    if (!mount.provider[name]) {
      throw new FsError('NotSupported', url, `the provider mounted at ${mount.prefix} does not support ${name}()`)
    }
    return mount.provider as FsProvider & Required<Pick<FsProvider, K>>
  }

  private _connect(watcher: Watcher, mount: Mount) {
    const { provider, prefix } = mount
    if (!provider.watch) {
      throw new FsError('NotSupported', watcher.url, `the provider mounted at ${prefix} does not support watch()`)
    }
    const dispose = provider.watch(watcher)
    this._watchers.set(watcher, { mount, dispose })
  }

  // The provider watch is disposed at once, and reports no more events.
  private async _disconnect(watcher: Watcher) {
    const connection = this._watchers.get(watcher)
    if (!connection) return
    this._watchers.set(watcher, undefined)
    await connection.dispose()
  }

  private _reroute() {
    const stops: Promise<void>[] = []
    for (const [watcher, connection] of this._watchers) {
      const mount = this._match(watcher.url)
      if (mount === connection?.mount) continue
      stops.push(this._disconnect(watcher).catch(error => watcher.emit('error', error)))
      if (!mount) {
        this.ctx.logger.debug('watch of %s is suspended without a provider', watcher.url.href)
        continue
      }
      try {
        this._connect(watcher, mount)
      } catch (error) {
        watcher.emit('error', error)
      }
    }
    return Promise.all(stops).then(() => {})
  }

  /** Create a reference to a file. The location is resolved now, and routed at each operation. */
  file(path: string | URL): FileRef {
    return new FileRef(this, this.resolve(path))
  }

  /**
   * Resolve unless the operation is known to be denied: a missing location
   * rejects with `NotFound`, and a denial by the storage with `PermissionDenied`.
   */
  async access(path: string | URL, mode: AccessMode): Promise<void> {
    // checked here, so that a provider receives only the modes it is declared to receive
    if (!accessModes.includes(mode)) {
      throw new TypeError(`expected an access mode of ${accessModes.map(mode => JSON.stringify(mode)).join(', ')}, got ${JSON.stringify(mode)}`)
    }
    const url = this.resolve(path)
    return this._provider(url, 'access').access(url, mode)
  }

  /**
   * Rename an entry. An existing file at `dest` is replaced; a non-empty
   * directory fails with `DirectoryNotEmpty`. Locations of two different
   * mounts fail with `CrossesDevices`.
   */
  async rename(src: string | URL, dest: string | URL): Promise<void> {
    const from = this.resolve(src)
    const to = this.resolve(dest)
    const mount = this._route(from)
    if (this._route(to) !== mount) {
      throw new FsError('CrossesDevices', from, `cannot rename ${from.href} to ${to.href} of another mount`)
    }
    return this._provider(from, 'rename', mount).rename(from, to)
  }

  /**
   * Remove a file or an empty directory, or with `recursive` a directory with
   * every entry below it. A symbolic link is removed itself, also when named
   * with a trailing separator or with `recursive`, and its target is not
   * touched. With `force`, a missing location is not an error.
   */
  async remove(path: string | URL, options: RemoveOptions = {}): Promise<void> {
    const url = this.resolve(path)
    try {
      await this._provider(url, 'remove').remove(url, { recursive: !!options.recursive })
    } catch (error) {
      if (options.force && error instanceof FsError && error.code === 'NotFound') return
      throw error
    }
  }

  /**
   * Report the metadata of an entry. A symbolic link is followed unless
   * `follow` is `false`, which reports the link itself. A trailing separator
   * requires a directory, and follows a link in the last component also with
   * `follow: false`. A missing location fails with `NotFound`.
   */
  async stat(path: string | URL, options: StatOptions = {}): Promise<Stats> {
    const url = this.resolve(path)
    return this._provider(url, 'stat').stat(url, { follow: options.follow ?? true })
  }

  /**
   * Resolve to `false` where `stat()` fails with `NotFound` or
   * `NotADirectory`, to `true` where it succeeds, and reject with any other
   * error of `stat()`.
   */
  async exists(path: string | URL): Promise<boolean> {
    try {
      await this.stat(path)
      return true
    } catch (error) {
      if (error instanceof FsError && (error.code === 'NotFound' || error.code === 'NotADirectory')) return false
      throw error
    }
  }

  /**
   * List the entries of a directory in an unspecified order. Entries added or
   * removed during the iteration may or may not be listed. A failure,
   * including a missing location or a non-directory, is thrown from the
   * iteration.
   */
  async* readdir(path: string | URL): AsyncIterable<DirEntry> {
    const url = this.resolve(path)
    for await (const { name, type } of this._provider(url, 'readdir').readdir(url)) {
      yield { name, type, url: entryUrl(url, name) }
    }
  }

  /**
   * Create a directory whose parent exists. An existing entry fails with
   * `AlreadyExists`, and a missing parent with `NotFound`. With `recursive`,
   * missing parents are created and an existing directory, also through a
   * link, is not an error; an existing non-directory still fails with
   * `AlreadyExists`.
   */
  async mkdir(path: string | URL, options: MkdirOptions = {}): Promise<void> {
    const url = this.resolve(path)
    return this._provider(url, 'mkdir').mkdir(url, { recursive: !!options.recursive })
  }

  /**
   * Create a symbolic link at `path` that stores `target` as given. A relative
   * target is relative to the directory of the link. An existing entry at
   * `path` fails with `AlreadyExists`.
   */
  async symlink(target: string, path: string | URL): Promise<void> {
    if (typeof target !== 'string') {
      throw new TypeError(`expected the target of a link as a string, got ${typeof target}`)
    }
    const url = this.resolve(path)
    return this._provider(url, 'symlink').symlink(target, url)
  }

  /** Return the target of a symbolic link as stored. An entry of another type fails with `NotALink`. */
  async readlink(path: string | URL): Promise<string> {
    const url = this.resolve(path)
    return this._provider(url, 'readlink').readlink(url)
  }

  /**
   * Copy a file, or with `recursive` a directory with every entry below it,
   * also between two mounts. The parent of `dest` is not created, and mode,
   * times and other metadata are not copied.
   *
   * - An existing file at `dest` is replaced, unless `overwrite` is `false`,
   *   which fails with `AlreadyExists`. A file onto an existing directory fails
   *   with `IsADirectory`, a directory onto an existing file with
   *   `NotADirectory`, and a directory onto an existing directory merges the
   *   entries.
   * - A symbolic link is copied as a link with the same target, unless
   *   `dereference` is set, which copies what it points to.
   * - A `dest` at or below `src` fails with `InvalidPath` before any I/O.
   *
   * A failure stops the copy, and keeps what has been copied before it.
   */
  async copy(src: string | URL, dest: string | URL, options: CopyOptions = {}): Promise<void> {
    const from = this.resolve(src)
    const to = this.resolve(dest)
    if (contains(from, to)) {
      throw new FsError('InvalidPath', to, `cannot copy ${from.href} to ${to.href} at or below itself`)
    }
    const { recursive = false, overwrite = true, dereference = false } = options
    const { type } = await this.stat(from, { follow: dereference })
    await this._copy(from, to, type, { recursive, overwrite, dereference })
  }

  private async _copy(from: URL, to: URL, type: EntryType, options: Required<CopyOptions>) {
    if (type === 'symlink') return this._copyLink(from, to, options)
    if (type === 'directory') return this._copyDirectory(from, to, options)
    if (type !== 'file') {
      throw new FsError('NotSupported', from, `cannot copy ${from.href}, which is neither a file, a directory nor a link`)
    }
    const existing = await this._statIfExists(to, true)
    if (existing?.type === 'directory') {
      throw new FsError('IsADirectory', to, `cannot copy the file ${from.href} onto the directory ${to.href}`)
    }
    if (existing && !options.overwrite) {
      throw new FsError('AlreadyExists', to, `cannot copy ${from.href} onto the existing ${to.href}`)
    }
    const mount = this._route(from)
    if (this._route(to) === mount && mount.provider.copy) {
      return mount.provider.copy(from, to)
    }
    const source = this._provider(from, 'read').read(from)
    const target = this._provider(to, 'write')
    // a failure to open the source is reported before the destination is written
    const body = await primed(source)
    try {
      await target.write(to, body)
    } catch (error) {
      await body.cancel(error).catch(() => {})
      throw error
    }
  }

  private async _copyDirectory(from: URL, to: URL, options: Required<CopyOptions>) {
    if (!options.recursive) {
      throw new FsError('IsADirectory', from, `cannot copy the directory ${from.href} without \`recursive\``)
    }
    // listed before the destination is created
    const entries: DirEntry[] = []
    for await (const entry of this.readdir(from)) entries.push(entry)
    const existing = await this._statIfExists(to, true)
    if (!existing) {
      await this.mkdir(to)
    } else if (existing.type !== 'directory') {
      throw new FsError('NotADirectory', to, `cannot copy the directory ${from.href} onto the non-directory ${to.href}`)
    }
    for (const { name, url, type } of entries) {
      const resolved = type === 'symlink' && options.dereference
        ? (await this.stat(url)).type
        : type
      await this._copy(url, entryUrl(to, name), resolved, options)
    }
  }

  private async _copyLink(from: URL, to: URL, options: Required<CopyOptions>) {
    // checked before the destination is changed
    const provider = this._provider(to, 'symlink')
    const target = await this.readlink(from)
    const existing = await this._statIfExists(to, false)
    if (existing?.type === 'directory') {
      throw new FsError('IsADirectory', to, `cannot copy the link ${from.href} onto the directory ${to.href}`)
    }
    if (existing) {
      if (!options.overwrite) {
        throw new FsError('AlreadyExists', to, `cannot copy ${from.href} onto the existing ${to.href}`)
      }
      await this.remove(to)
    }
    await provider.symlink(target, to)
  }

  // the metadata of `url`, or `undefined` for a missing location
  private async _statIfExists(url: URL, follow: boolean) {
    try {
      return await this.stat(url, { follow })
    } catch (error) {
      if (error instanceof FsError && error.code === 'NotFound') return
      throw error
    }
  }

  /** Watch a file or a directory. The watch ends with the calling fiber. */
  watch(path: string | URL, options: WatchOptions = {}): Watcher {
    const url = this.resolve(path)
    const mount = this._route(url)
    return new Watcher(this.ctx, url, options, (watcher) => {
      this._connect(watcher, mount)
      return async () => {
        const connection = this._watchers.get(watcher)
        this._watchers.delete(watcher)
        await connection?.dispose()
      }
    })
  }
}

export namespace Fs {
  export interface Intercept {
    /**
     * The base URL of relative references, which names a directory. A
     * relative value is resolved against the base URL of the outer context.
     * On Windows, a drive-letter path, such as `C:\app`, is taken as a file path.
     */
    baseUrl?: string
  }

  export interface Config {
    /**
     * The base URL of relative references, which is absolute and names a
     * directory. On Windows, a drive-letter path, such as `C:\app`, is taken as
     * a file path. Defaults to the working directory.
     */
    baseUrl?: string
  }
}

type Operation =
  | 'read' | 'write' | 'access' | 'rename' | 'remove'
  | 'stat' | 'readdir' | 'mkdir' | 'copy' | 'symlink' | 'readlink'

/**
 * A provider of the locations below its mount. An operation fails with an
 * `FsError`; a missing method makes it fail with `NotSupported`.
 */
export interface FsProvider {
  /**
   * Return a stream of the content of a file. A failure, including a missing
   * file, errors the stream.
   */
  read?(url: URL): ReadableStream<Uint8Array>
  /**
   * Replace the content of a file with the data of `body`, creating the file
   * but not its parent directory. An error of `body` rejects the write.
   */
  write?(url: URL, body: ReadableStream<Uint8Array>): Promise<void>
  /** Reject when the operation of `mode` is known to be denied. */
  access?(url: URL, mode: AccessMode): Promise<void>
  /** Rename an entry to a location of the same mount. */
  rename?(src: URL, dest: URL): Promise<void>
  /**
   * Remove a file, an empty directory, or with `recursive` a directory with
   * every entry below it, and fail with `NotFound` on a missing location. A
   * symbolic link in the last component is removed itself, also when named
   * with a trailing separator.
   */
  remove?(url: URL, options: Required<Omit<RemoveOptions, 'force'>>): Promise<void>
  /** Report the metadata of an entry, with the semantics of `Fs.stat()`. */
  stat?(url: URL, options: Required<StatOptions>): Promise<Stats>
  /**
   * List the names and the types of the entries of a directory, from which
   * `@cordisjs/fs` builds their locations. A failure is thrown from the iteration.
   */
  readdir?(url: URL): AsyncIterable<Omit<DirEntry, 'url'>>
  /** Create a directory, with the semantics of `Fs.mkdir()`. */
  mkdir?(url: URL, options: Required<MkdirOptions>): Promise<void>
  /**
   * Copy the content of a file to a location of the same mount, replacing an
   * existing file there. `@cordisjs/fs` calls it only for a file, after it has
   * checked the destination.
   */
  copy?(src: URL, dest: URL): Promise<void>
  /** Create a symbolic link at `url` that stores `target` as given. */
  symlink?(target: string, url: URL): Promise<void>
  /** Return the target of a symbolic link as stored, and fail with `NotALink` on another entry. */
  readlink?(url: URL): Promise<string>
  /**
   * Start serving `watcher`, and return a function that disposes it. The
   * provider reports through `watcher.emit()`, with a `ready` once the initial
   * scan is done, and reports nothing once the returned function is called.
   */
  watch?(watcher: Watcher): () => Awaitable<void>
}

export interface BaseFs extends FsProvider {}

/** A provider that mounts itself at `config.mount`. */
export abstract class BaseFs {
  static inject = ['fs']

  constructor(public ctx: Context, config: BaseFs.Config) {
    ctx.fs.mount(config.mount, this)
  }
}

export namespace BaseFs {
  export interface Config {
    /** a scheme such as `s3:`, a URL such as `file:///`, or the empty string for every location */
    mount: string
  }
}

export default Fs
