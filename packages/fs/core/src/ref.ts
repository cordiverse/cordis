import type { EntryType, WriteOptions, WriteResult } from './entry.ts'
import { FsError } from './error.ts'
import type { Fs } from './index.ts'
import { assertLocation, isHierarchical, Path } from './path.ts'
import { appendSlice } from './slice.ts'
import { checkVersion } from './version.ts'

/** The data accepted by `FileRef.write()`. A string is encoded as UTF-8. */
export type WriteSource = string | ArrayBuffer | ArrayBufferView<ArrayBuffer> | Blob | ReadableStream<Uint8Array>

/** The options of a read, as a provider receives them. */
export interface ReadOptions {
  /**
   * The first byte of the range, `0` by default. As in `Blob.slice()`, a
   * negative value counts from the end, and the range is clamped to the size.
   */
  start?: number
  /** The end of the range, exclusive, with the semantics of `start`; the size by default. */
  end?: number
  /**
   * The version of the whole file, as `Stats.version` reports it. The read
   * fails with `VersionMismatch` before any byte unless the file has this
   * version. A provider receives it only with the capability `conditional.read`.
   */
  ifMatch?: string
}

/** The result of a read by a provider. */
export interface ReadResult {
  /** the content, or the range of it that the options select */
  stream: ReadableStream<Uint8Array>
  /** the version of the file whose bytes `stream` delivers, if the provider reports it */
  version?: string
}

// A blob of the bytes of `data`, which can be read again, unless it is a
// stream. A blob is copied, so that a subclass does not change its bytes.
function toSource(data: WriteSource): Blob | ReadableStream<Uint8Array> {
  if (data instanceof ReadableStream) return data
  return new Blob([data])
}

// Converts a number as `[Clamp] long long`, as the bounds of `Blob.slice()`.
function toIndex(value: unknown, name: string) {
  if (value === undefined) return
  if (typeof value !== 'number') {
    throw new TypeError(`expected \`${name}\` as a number, got ${typeof value}`)
  }
  if (Number.isNaN(value)) return 0
  const x = Math.min(Math.max(value, -Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
  const rounded = Math.round(x)
  // `Math.round()` rounds a tie up, and `+ 0` turns `-0` into `0`
  return (rounded - x === 0.5 && rounded % 2 ? rounded - 1 : rounded) + 0
}

/** The JSON representation of a reference, as `EntryRef.toJSON()` returns it. */
export interface EntryJSON {
  /** the location, as `URL.href` */
  url: string
  /** the last name of the location, decoded */
  name: string
  /** the type of an entry of a listing, as `DirEntryRef.type` */
  type?: EntryType
}

/** A reference to an entry. Creating it performs no I/O. */
export class EntryRef {
  constructor(protected fs: Fs, public readonly url: URL) {}

  /** the last name of the location, decoded */
  get name(): string {
    const path = this.url.pathname.replace(/\/+$/, '')
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
  }

  /** Returns the location and the name, and the type of an entry of a listing. */
  toJSON(): EntryJSON {
    return { url: this.url.href, name: this.name, type: this['type'] as EntryType | undefined }
  }
}

/** A reference to a file, or to a range of its content. Creating it performs no I/O. */
export class FileRef extends EntryRef {
  // `_slices` is absent for a reference not created by `slice()`
  constructor(fs: Fs, url: URL, private _slices?: readonly ReadOptions[]) {
    super(fs, url)
  }

  /**
   * Returns a reference to a range of the content, with the semantics of
   * `Blob.slice()`, relative to this reference. The range is resolved at each
   * read. Writing to a slice rejects with a `TypeError`.
   */
  slice(start?: number, end?: number): FileRef {
    const from = toIndex(start, 'start') ?? 0
    const to = toIndex(end, 'end')
    return new FileRef(this.fs, this.url, appendSlice(this._slices ?? [], from, to))
  }

  /**
   * Returns a stream of the current content. A failure of the provider,
   * including a missing file, errors the stream. The consumer owns each chunk.
   *
   * - `ifMatch`: the version of the whole file, also for a slice. The stream
   *   fails with `VersionMismatch` before any byte unless the location is a
   *   file of this version. A provider that can check no version makes the
   *   call throw `NotSupported`.
   */
  stream(options: Pick<ReadOptions, 'ifMatch'> = {}): ReadableStream<Uint8Array> {
    const { ifMatch } = options
    checkVersion(ifMatch)
    return this.fs['_read'](this.url, this._slices ?? [], ifMatch)
  }

  /** Reads the current content, with the options of `stream()`. */
  async bytes(options?: Pick<ReadOptions, 'ifMatch'>): Promise<Uint8Array<ArrayBuffer>> {
    const chunks: Uint8Array[] = []
    let length = 0
    const reader = this.stream(options).getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      length += value.byteLength
    }
    // a chunk that spans its whole buffer is returned without a copy
    if (chunks.length === 1) {
      const { buffer, byteOffset } = chunks[0]
      if (buffer instanceof ArrayBuffer && byteOffset === 0 && buffer.byteLength === length) return new Uint8Array(buffer)
    }
    const result = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }

  /** Reads the current content, with the options of `stream()`. */
  async arrayBuffer(options?: Pick<ReadOptions, 'ifMatch'>): Promise<ArrayBuffer> {
    return (await this.bytes(options)).buffer
  }

  /** Reads the current content as UTF-8 text, with the options of `stream()`. A byte order mark is removed. */
  async text(options?: Pick<ReadOptions, 'ifMatch'>): Promise<string> {
    return new TextDecoder().decode(await this.bytes(options))
  }

  /** Reads the current content as UTF-8 text and parses it as JSON, with the options of `stream()`. */
  async json<T = any>(options?: Pick<ReadOptions, 'ifMatch'>): Promise<T> {
    return JSON.parse(await this.text(options))
  }

  /**
   * Replaces the content, creating the file if it is missing. The parent
   * directory is not created. A stream is consumed by the provider, and an
   * error of the stream rejects the write. A symbolic link at the location
   * is followed, also a dangling one.
   *
   * - `mode`: the permission bits of the file, where the provider has them.
   * - `exclusive`: an existing file fails with `AlreadyExists`, checked when
   *   the file is created. It requires a provider with the capability
   *   `exclusive`.
   * - `atomic`: a reader observes either the previous or the complete new
   *   content, and an existing file keeps its permission bits unless `mode`
   *   is given. It requires a provider with the capability `atomic`; without
   *   `exclusive`, also one with the capability `exclusive`, `rename()` and
   *   `remove()`.
   * - `ifMatch`: the version of the file to be replaced, as `Stats.version`
   *   reports it. A missing file, an entry of another type or another version
   *   fails with `VersionMismatch`, and the file is not changed. It cannot be
   *   combined with `exclusive`. It requires a provider with the capability
   *   `conditional.write`, or with `conditional.stat`, by which the version is
   *   checked before the write, or before each rename of an atomic write
   *   composed by `@cordisjs/fs`. The latter does not exclude a change
   *   between the check and the write.
   *
   * With `exclusive` or `atomic`, a link that leads into another mount fails
   * with `CrossesDevices`.
   *
   * Resolves to the version of the written content, if the provider reports it.
   */
  async write(data: WriteSource, options: WriteOptions = {}): Promise<WriteResult> {
    if (this._slices) {
      throw new TypeError(`cannot write a slice of ${this.url.href}`)
    }
    return this.fs['_write'](this.url, toSource(data), options)
  }
}

/**
 * A reference to a directory. Creating it performs no I/O. Its URL ends with
 * `/`, and serves as the base URL of the paths given to `dir()` and `file()`.
 * A path resolved against it may leave it, such as `../x` or `/x`; whether a
 * location can be accessed depends on the provider to which it is routed and
 * on the underlying storage.
 */
export class DirRef extends EntryRef {
  /** A copy of `url` with a trailing `/`. */
  constructor(fs: Fs, url: URL) {
    url = new URL(url)
    assertLocation(url)
    if (!isHierarchical(url)) {
      throw new FsError('InvalidPath', url, `expected a location with a hierarchical path, got ${url.href}`)
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    super(fs, url)
  }

  /** Create a reference to a directory, resolving `path` against this directory. */
  dir(path: Path): DirRef {
    return new DirRef(this.fs, this.fs.resolve(path, this.url))
  }

  /** Create a reference to a file, resolving `path` against this directory. */
  file(path: Path): FileRef {
    return new FileRef(this.fs, this.fs.resolve(path, this.url))
  }

  /**
   * List the entries of the directory in an unspecified order. The location
   * is routed when the iteration starts. Entries added or removed during the
   * iteration may or may not be listed. A failure, including a missing
   * location or a non-directory, is thrown from the iteration.
   */
  list(): AsyncIterable<DirEntryRef> {
    return this.fs['_list'](this.url)
  }
}

/**
 * An entry of a directory, as listed by `DirRef.list()`: a reference to it
 * with its type at the time of the listing. A file is a `FileRef`, and a
 * directory a `DirRef`. The type is that of the entry itself, not of the
 * target of a link, so a link to a file is an `EntryRef`.
 */
export type DirEntryRef =
  | (FileRef & { readonly type: 'file' })
  | (DirRef & { readonly type: 'directory' })
  | (EntryRef & { readonly type: Exclude<EntryType, 'file' | 'directory'> })
