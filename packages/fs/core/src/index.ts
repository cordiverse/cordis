import { Context, Service } from 'cordis'
import { Awaitable } from 'cosmokit'
import { pathToFileURL } from 'node:url'
import { CopyOptions, DirEntry, EntryType, MkdirOptions, RemoveOptions, StatOptions, Stats, WriteOptions } from './entry.ts'
import { FsError } from './error.ts'
import { DirEntryRef, EntryRef, FileRef, ReadOptions } from './file.ts'
import { resolveSlices, sliceStream } from './slice.ts'
import { assertLocation, isHierarchical, isUrl, Path, resolvePath } from './path.ts'
import { Attempts, createTemporary, fileTarget, reserveFile } from './write.ts'
import { Watcher, WatchOptions } from './watcher.ts'

export type * from './entry.ts'
export * from './error.ts'
export * from './file.ts'
export * from './filter.ts'
export type * from './path.ts'
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
  const url = new URL(prefix)
  assertLocation(url)
  return url.href.endsWith('/') ? url.href : url.href + '/'
}

/** The number of retries of the rename of an atomic write that fails with `Busy`. */
const RENAME_RETRIES = 10
/** The delay before the first retry of a rename in milliseconds, which grows linearly with each retry. */
const RENAME_BACKOFF = 20

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function isCode(error: unknown, code: FsError.Code) {
  return error instanceof FsError && error.code === code
}

// the working directory as a URL, on a runtime that has one
function getWorkingDirectory() {
  if (typeof process === 'undefined') return
  return pathToFileURL(process.cwd() + '/')
}

// A base URL names a directory, and has no query or fragment. A URL with an
// opaque path, such as `mem:bucket/`, cannot resolve a path.
function toBaseUrl(input: string, base: URL | undefined) {
  let url: URL
  try {
    url = resolvePath(input, base)
    new URL('.', url)
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    url.search = ''
    url.hash = ''
    assertLocation(url)
  } catch (error) {
    throw new TypeError(`invalid base URL ${JSON.stringify(input)}`, { cause: error })
  }
  return url.href
}

// the URL without its query, its fragment and its trailing separators
function toKey(url: URL) {
  return url.href.slice(0, url.href.length - url.hash.length - url.search.length).replace(/\/+$/, '')
}

// whether `url` is `base` or lies below it, compared by the URLs alone
function contains(base: URL, url: URL) {
  // a location without a hierarchical path contains no other location
  if (!isHierarchical(base) || !isHierarchical(url)) return base.href === url.href
  const prefix = toKey(base)
  const key = toKey(url)
  return key === prefix || key.startsWith(prefix + '/')
}

async function fileSize(stat: () => Promise<Stats>) {
  try {
    const stats = await stat()
    if (stats.type === 'file' && Number.isSafeInteger(stats.size) && stats.size >= 0) return stats.size
  } catch {
    // The read can still proceed without metadata.
  }
}

// Opens the read with the file size when available. Cancelling during stat leaves the source unopened.
function readAfterStat(stat: () => Promise<Stats>, open: (size?: number) => ReadableStream<Uint8Array>) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let cancelled = false
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const size = await fileSize(stat)
      if (cancelled) return
      reader = open(size).getReader()
      reader.closed.catch(error => controller.error(error))
    },
    async pull(controller) {
      const { done, value } = await reader!.read()
      if (cancelled) return
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) {
      cancelled = true
      return reader?.cancel(reason)
    },
  }, { highWaterMark: 0 })
}

// A stream of the same chunks as `stream`, whose first chunk has been read,
// so that a failure to open the source is reported before it is consumed.
async function primed(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  async function read() {
    try {
      const chunk = await reader.read()
      if (chunk.done) reader.releaseLock()
      return chunk
    } catch (error) {
      reader.releaseLock()
      throw error
    }
  }
  const first = await read()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done) return controller.close()
      controller.enqueue(first.value)
    },
    async pull(controller) {
      const { done, value } = await read()
      if (done) return controller.close()
      controller.enqueue(value)
    },
    cancel(reason) {
      const pending = reader.cancel(reason)
      reader.releaseLock()
      return pending
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
  public config: Fs.Config

  constructor(ctx: Context, config: Fs.Config = {}) {
    super(ctx, 'fs')
    // the working directory is the default, and the base URL of a path
    const { baseUrl } = config
    const cwd = baseUrl === undefined || !isUrl(baseUrl) ? getWorkingDirectory() : undefined
    const value = baseUrl ?? cwd?.href
    this.config = { ...config, baseUrl: value === undefined ? undefined : toBaseUrl(value, cwd) }
  }

  /**
   * The base URL of paths, which names a directory: its path ends with `/`,
   * and it has no query or fragment. The `baseUrl` of the config is followed
   * by that of each intercept, from the outermost to the innermost, which is
   * resolved against the result of the preceding ones. Without a base URL,
   * only absolute URLs are locations.
   */
  get baseUrl(): URL | undefined {
    const { baseUrl } = this[Service.resolveIntercept]()
    return baseUrl === undefined ? undefined : new URL(baseUrl)
  }

  [Service.mergeIntercept](...values: Fs.Intercept[]): Fs.Intercept {
    let baseUrl = this.config.baseUrl
    for (const value of values) {
      if (value?.baseUrl === undefined) continue
      baseUrl = toBaseUrl(value.baseUrl, baseUrl === undefined ? undefined : new URL(baseUrl))
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
   * Resolve a location, as `Path` describes it, against `base`, which names a
   * directory and defaults to `baseUrl`. A location that cannot be resolved,
   * such as a path without a base URL, or a URL with a hierarchical path and a
   * query, a fragment, an encoded `/` or an invalid percent-encoding, throws an
   * `FsError` with the code `InvalidPath`. A URL with an opaque path, such as a
   * `data:` URL, is left to its provider.
   */
  resolve(path: Path, base = this.baseUrl): URL {
    const url = resolvePath(path, base)
    assertLocation(url)
    return url
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
  file(path: Path): FileRef {
    return new FileRef(this, this.resolve(path))
  }

  // 1. Without slices or the range capability, the chain is applied to a whole read.
  // 2. A single slice with accepted bounds is read as a range, without `stat()`.
  // 3. Otherwise, a size from `stat()` resolves the chain to one range. Without
  //    a size, the first slice is read as a range if its bounds are accepted,
  //    and the rest of the chain is applied to the stream.
  private _read(url: URL, slices: readonly ReadOptions[]): ReadableStream<Uint8Array> {
    const provider = this._provider(url, 'read')
    const range = provider.capabilities?.range
    if (!range || !slices.length) return slices.reduce(sliceStream, provider.read(url, {}))

    const [first, ...rest] = slices
    const canReadFirst = range === 'signed' || (first.start ?? 0) >= 0 && (first.end ?? 0) >= 0
    if (canReadFirst && !rest.length) return provider.read(url, { ...first })

    const fallback = () => canReadFirst
      ? rest.reduce(sliceStream, provider.read(url, { ...first }))
      : slices.reduce(sliceStream, provider.read(url, {}))
    if (!provider.stat) return fallback()
    return readAfterStat(() => provider.stat!(url, { follow: true }), size => size === undefined
      ? fallback()
      : provider.read(url, resolveSlices(slices, size)))
  }

  // A blob is read by a new stream for each attempt. The stream of a failed
  // attempt, or an unread stream, is cancelled without waiting, as the
  // cancellation of one branch of a tee remains pending until the consumer
  // of the other branch finishes.
  private async _write(url: URL, data: Blob | ReadableStream<Uint8Array>, options: WriteOptions): Promise<void> {
    try {
      await this._writeFile(url, options, data instanceof Blob && 'write', async (mount, dest, options) => {
        const body = data instanceof Blob ? data.stream() : data
        try {
          await this._provider(dest, 'write', mount).write(dest, body, options)
        } catch (error) {
          if (body !== data) body.cancel(error).catch(() => {})
          throw error
        }
      })
    } catch (error) {
      if (!(data instanceof Blob)) data.cancel(error).catch(() => {})
      throw error
    }
  }

  // A write or a file copy to `url`, which `transfer` performs at a location
  // of the mount of `url`. A `retryable` transfer can be performed again, and
  // transfers the same content each time; a `copy` by the provider, which may
  // not create a file exclusively, also after an empty temporary file is
  // created. Without the capability `atomic`, an atomic write transfers the
  // content to an exclusively created temporary file beside the destination,
  // and renames it over the destination. A transfer that is not retryable
  // goes to an empty temporary file created before, which is removed on a
  // failure. A name is retried once for the whole operation.
  private async _writeFile(
    url: URL, options: WriteOptions, retryable: 'write' | 'copy' | false,
    transfer: (mount: Mount, dest: URL, options: WriteOptions) => Promise<void>,
  ) {
    const mount = this._route(url)
    const { provider } = mount
    const { atomic, exclusive, mode } = options
    const forwarded: WriteOptions = mode === undefined ? {} : { mode }
    if (exclusive) forwarded.exclusive = true
    const staged = !!atomic && !provider.capabilities?.atomic
    if (staged && (exclusive || !provider.rename)) {
      throw new FsError('NotSupported', url, `cannot atomically ${exclusive ? 'create' : 'replace'} a file at ${url.href}`)
    }
    if (atomic && !staged) forwarded.atomic = true
    if (!staged && !(exclusive && provider.realpath)) return transfer(mount, url, forwarded)

    const owns = (location: URL) => this._match(location) === mount
    const { url: dest, stats } = await fileTarget(url, mount, this._mounts.size, owns, staged)
    if ((isHierarchical(dest) && dest.pathname.endsWith('/')) || stats?.type === 'directory') {
      throw new FsError('IsADirectory', url, `expected a file at ${dest.href}`)
    }
    if (exclusive && stats) throw new FsError('AlreadyExists', dest, `file already exists: ${dest.href}`)
    if (!staged) return transfer(mount, dest, forwarded)
    if (stats && stats.type !== 'file') throw new FsError('NotSupported', url, `cannot replace a ${stats.type} at ${dest.href}`)
    if (stats && provider.access) await provider.access(dest, 'write')
    const attempts: Attempts = {}
    let temporary: URL | undefined
    if (retryable) {
      const finalMode = mode ?? stats?.mode
      let attempted: URL | undefined
      try {
        // the provider removes a file that it creates exclusively and then fails to write
        temporary = await createTemporary(dest, owns, (url) => {
          attempted = url
          return transfer(mount, url, finalMode === undefined ? { exclusive: true } : { mode: finalMode, exclusive: true })
        }, attempts)
      } catch (error) {
        // only an exclusive copy to the temporary file that the provider does not support
        const exclusiveCopy = retryable === 'copy' && provider.write && isCode(error, 'NotSupported')
        if (!exclusiveCopy || (error as FsError).url?.href !== attempted?.href) throw error
      }
    }
    // content that is transferred after an empty temporary file is created
    const reserved = !temporary
    if (!temporary) {
      const reservation = await reserveFile(dest, this._provider(dest, 'write', mount), owns, mode ?? stats?.mode, attempts)
      temporary = reservation.url
      if (reservation.mode !== undefined) forwarded.mode = reservation.mode
    }
    try {
      if (reserved) await transfer(mount, temporary, forwarded)
      for (let retries = 0; ; retries++) {
        try {
          return await provider.rename!(temporary, dest)
        } catch (error) {
          if (retries >= RENAME_RETRIES || !isCode(error, 'Busy')) throw error
        }
        await sleep(RENAME_BACKOFF * (retries + 1))
      }
    } catch (error) {
      await provider.remove?.(temporary, { recursive: false }).catch(() => {})
      throw error
    }
  }

  /**
   * Resolve unless the operation is known to be denied: a missing location
   * rejects with `NotFound`, and a denial by the storage with `PermissionDenied`.
   */
  async access(path: Path, mode: AccessMode): Promise<void> {
    // checked here, so that a provider receives only the modes it is declared to receive
    if (!accessModes.includes(mode)) {
      throw new TypeError(`expected an access mode of ${accessModes.map(mode => JSON.stringify(mode)).join(', ')}, got ${JSON.stringify(mode)}`)
    }
    const url = this.resolve(path)
    return this._provider(url, 'access').access(url, mode)
  }

  /**
   * Rename an entry. An existing file at `dest` is atomically replaced; a non-empty
   * directory fails with `DirectoryNotEmpty`. Locations of two different
   * mounts fail with `CrossesDevices`.
   */
  async rename(src: Path, dest: Path): Promise<void> {
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
  async remove(path: Path, options: RemoveOptions = {}): Promise<void> {
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
  async stat(path: Path, options: StatOptions = {}): Promise<Stats> {
    const url = this.resolve(path)
    return this._provider(url, 'stat').stat(url, { follow: options.follow ?? true })
  }

  /**
   * Resolve to `false` where `stat()` fails with `NotFound` or
   * `NotADirectory`, to `true` where it succeeds, and reject with any other
   * error of `stat()`.
   */
  async exists(path: Path): Promise<boolean> {
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
  async* readdir(path: Path): AsyncIterable<DirEntryRef> {
    const url = this.resolve(path)
    for await (const { name, type } of this._provider(url, 'readdir').readdir(url)) {
      const location = resolvePath([name], url)
      const entry = type === 'file' ? new FileRef(this, location) : new EntryRef(this, location)
      yield Object.defineProperty(entry, 'type', { value: type, enumerable: true }) as DirEntryRef
    }
  }

  /**
   * Create a directory whose parent exists. An existing entry fails with
   * `AlreadyExists`, and a missing parent with `NotFound`. With `recursive`,
   * missing parents are created and an existing directory, also through a
   * link, is not an error; an existing non-directory still fails with
   * `AlreadyExists`.
   */
  async mkdir(path: Path, options: MkdirOptions = {}): Promise<void> {
    const url = this.resolve(path)
    return this._provider(url, 'mkdir').mkdir(url, { recursive: !!options.recursive })
  }

  /**
   * Create a symbolic link at `path` that stores `target` as given. A relative
   * target is relative to the directory of the link. An existing entry at
   * `path` fails with `AlreadyExists`.
   */
  async symlink(target: string, path: Path): Promise<void> {
    if (typeof target !== 'string') {
      throw new TypeError(`expected the target of a link as a string, got ${typeof target}`)
    }
    const url = this.resolve(path)
    return this._provider(url, 'symlink').symlink(target, url)
  }

  /** Return the target of a symbolic link as stored. An entry of another type fails with `NotALink`. */
  async readlink(path: Path): Promise<string> {
    const url = this.resolve(path)
    return this._provider(url, 'readlink').readlink(url)
  }

  /**
   * Copy a file, or with `recursive` a directory with every entry below it,
   * also between two mounts. The parent of `dest` is not created. The
   * permission bits of a file are copied where both providers have them;
   * times and other metadata are not copied.
   *
   * - An existing file at `dest` is replaced. A link at `dest` is followed,
   *   including a dangling link.
   * - A file onto an existing directory fails with `IsADirectory`, a
   *   directory onto an existing file with `NotADirectory`, and a directory
   *   onto an existing directory merges the entries.
   * - A symbolic link is copied as a link with the same target.
   * - A `dest` at or below `src` fails with `InvalidPath` before any I/O.
   *
   * Options:
   *
   * - `dereference`: a link is copied as what it points to.
   * - `exclusive`, `atomic`: a file is copied as `FileRef.write()` writes with
   *   them. With `atomic`, a directory, or a link copied as a link, fails with
   *   `NotSupported` before any change.
   *
   * A failure stops the copy, and keeps what has been copied before it.
   */
  async copy(src: Path, dest: Path, options: CopyOptions = {}): Promise<void> {
    const from = this.resolve(src)
    const to = this.resolve(dest)
    if (contains(from, to)) {
      throw new FsError('InvalidPath', to, `cannot copy ${from.href} to ${to.href} at or below itself`)
    }
    const { recursive = false, exclusive = false, dereference = false, atomic = false } = options
    const stats = await this.stat(from, { follow: dereference })
    await this._copy(from, to, stats.type, { recursive, exclusive, dereference, atomic }, stats)
  }

  // `stats` of the source, if they have been obtained
  private async _copy(from: URL, to: URL, type: EntryType, options: Required<CopyOptions>, stats?: Stats) {
    if (options.atomic && type !== 'file') {
      throw new FsError('NotSupported', from, `cannot atomically copy a ${type} at ${from.href}`)
    }
    if (type === 'symlink') return this._copyLink(from, to, options)
    if (type === 'directory') return this._copyDirectory(from, to, options)
    if (type !== 'file') {
      throw new FsError('NotSupported', from, `cannot copy ${from.href}, which is neither a file, a directory nor a link`)
    }
    const source = this._route(from)
    // a copy by the provider reads the source again for each attempt
    const retryable = this._route(to) === source && !!source.provider.copy && 'copy'
    await this._writeFile(to, { ...options, mode: stats?.mode }, retryable, async (mount, dest, writeOptions) => {
      const { mode: destinationMode, ...transfer } = writeOptions
      if (mount === source && mount.provider.copy) {
        return mount.provider.copy(from, dest, transfer)
      }
      const target = this._provider(dest, 'write', mount)
      const mode = (stats ?? await this.stat(from)).mode ?? destinationMode
      const body = await primed(this._provider(from, 'read', source).read(from, {}))
      try {
        await target.write(dest, body, mode === undefined ? transfer : { ...transfer, mode })
      } catch (error) {
        body.cancel(error).catch(() => {})
        throw error
      }
    })
  }

  private async _copyDirectory(from: URL, to: URL, options: Required<CopyOptions>) {
    if (!options.recursive) {
      throw new FsError('IsADirectory', from, `cannot copy the directory ${from.href} without \`recursive\``)
    }
    // listed before the destination is created
    const entries: DirEntryRef[] = []
    for await (const entry of this.readdir(from)) entries.push(entry)
    const existing = await this._statIfExists(to, true)
    if (!existing) {
      await this.mkdir(to)
    } else if (existing.type !== 'directory') {
      throw new FsError('NotADirectory', to, `cannot copy the directory ${from.href} onto the non-directory ${to.href}`)
    }
    for (const { name, url, type } of entries) {
      const stats = type === 'symlink' && options.dereference ? await this.stat(url) : undefined
      await this._copy(url, resolvePath([name], to), stats?.type ?? type, options, stats)
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
      if (options.exclusive) {
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
  watch(path: Path, options: WatchOptions = {}): Watcher {
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
     * The directory against which paths are resolved, as a path or an
     * absolute URL in a string of `Path`. A path is resolved against the base
     * URL of the outer context.
     */
    baseUrl?: string
  }

  export interface Config {
    /**
     * The directory against which paths are resolved, as a path or an
     * absolute URL in a string of `Path`. A path is resolved against the
     * working directory, which is also the default. On a runtime without
     * one, it is an absolute URL or absent, and without it only absolute URLs
     * are locations.
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
  /** The behaviors that the provider implements itself, for every location of the mount. */
  readonly capabilities?: FsProvider.Capabilities
  /**
   * Return a stream of the content of a file. A failure, including a missing
   * file, errors the stream. The consumer owns each chunk once it is
   * enqueued, and the provider does not modify it afterwards. The range
   * capability determines which bounds may occur in `options`. A provider
   * without it receives empty options.
   */
  read?(url: URL, options: ReadOptions): ReadableStream<Uint8Array>
  /**
   * Replace the content of a file with the data of `body`, creating the file
   * but not its parent directory. An error of `body` rejects the write.
   *
   * - `mode`: a provider with permissions gives the file these permission
   *   bits before its content.
   * - `exclusive`: create the file only where no entry exists, a dangling link
   *   included, and fail with `AlreadyExists` otherwise; remove the created
   *   file if the write then fails. A provider that cannot create a file
   *   exclusively fails with `NotSupported`.
   * - `atomic`: received only with the capability `atomic`.
   */
  write?(url: URL, body: ReadableStream<Uint8Array>, options: WriteOptions): Promise<void>
  /** Reject when the operation of `mode` is known to be denied. */
  access?(url: URL, mode: AccessMode): Promise<void>
  /** Rename within a mount, atomically replacing an existing destination file. */
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
  readdir?(url: URL): AsyncIterable<DirEntry>
  /** Create a directory, with the semantics of `Fs.mkdir()`. */
  mkdir?(url: URL, options: Required<MkdirOptions>): Promise<void>
  /**
   * Copy a file to a location of the same mount, with the semantics of
   * `Fs.copy()` for a file. `exclusive` and `atomic` are those of `write()`.
   */
  copy?(src: URL, dest: URL, options: Pick<WriteOptions, 'exclusive' | 'atomic'>): Promise<void>
  /** Create a symbolic link at `url` that stores `target` as given. */
  symlink?(target: string, url: URL): Promise<void>
  /** Return the target of a symbolic link as stored, and fail with `NotALink` on another entry. */
  readlink?(url: URL): Promise<string>
  /**
   * Return the location that `url` designates with every symbolic link
   * resolved by the rules of the storage, which may be one of another mount.
   *
   * - A link in the last component is resolved, also a dangling one.
   * - The last component may be missing; a missing parent fails with `NotFound`.
   *
   * `@cordisjs/fs` resolves through it the destination of an exclusive write,
   * and of an atomic write without the capability `atomic`. A provider
   * without it guarantees that no symbolic link, in a parent directory or in
   * the last component, changes the entry that a write gives content to.
   */
  realpath?(url: URL): Promise<URL>
  /**
   * Start serving `watcher`, and return a function that disposes it. The
   * provider reports through `watcher.emit()`, with a `ready` once the initial
   * scan is done, and reports nothing once the returned function is called.
   */
  watch?(watcher: Watcher): () => Awaitable<void>
}

export namespace FsProvider {
  /** The capabilities of a provider; an absent key is not declared. */
  export interface Capabilities {
    /** `unsigned` accepts omitted or non-negative bounds, and `signed` every bound. */
    range?: 'unsigned' | 'signed'
    /** `write()` and `copy()` replace a file at once, and receive `atomic`. */
    atomic?: boolean
  }
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
