import { Context, Service } from 'cordis'
import { Awaitable } from 'cosmokit'
import { pathToFileURL } from 'node:url'
import { FsError } from './error.ts'
import { FileRef } from './file.ts'
import { Watcher, WatchOptions } from './watcher.ts'

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

export interface RemoveOptions {
  /** A missing location is not an error. */
  force?: boolean
}

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
   * Remove a file or an empty directory. A symbolic link is removed itself,
   * also when named with a trailing separator, and its target is not touched.
   */
  async remove(path: string | URL, options: RemoveOptions = {}): Promise<void> {
    const url = this.resolve(path)
    try {
      await this._provider(url, 'remove').remove(url)
    } catch (error) {
      if (options.force && error instanceof FsError && error.code === 'NotFound') return
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

type Operation = 'read' | 'write' | 'access' | 'rename' | 'remove'

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
  /** Remove a file or an empty directory, and fail with `NotFound` on a missing location. */
  remove?(url: URL): Promise<void>
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
