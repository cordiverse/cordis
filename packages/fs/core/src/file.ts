import type { EntryType, WriteOptions } from './entry.ts'
import type { Fs } from './index.ts'
import { appendSlice } from './slice.ts'

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
}

function toStream(data: WriteSource): ReadableStream<Uint8Array> {
  if (data instanceof ReadableStream) return data
  return new Blob([data]).stream()
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

/** A reference to an entry. Creating it performs no I/O. */
export class EntryRef {
  constructor(protected fs: Fs, public readonly url: URL) {}

  /** the last name of the location, decoded */
  get name(): string {
    const path = this.url.pathname.replace(/\/+$/, '')
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
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
   */
  stream(): ReadableStream<Uint8Array> {
    return this.fs['_read'](this.url, this._slices ?? [])
  }

  /** Reads the current content. */
  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    const chunks: Uint8Array[] = []
    let length = 0
    const reader = this.stream().getReader()
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

  /** Reads the current content. */
  async arrayBuffer(): Promise<ArrayBuffer> {
    return (await this.bytes()).buffer
  }

  /** Reads the current content as UTF-8 text. A byte order mark is removed. */
  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes())
  }

  /** Reads the current content as UTF-8 text and parses it as JSON. */
  async json(): Promise<any> {
    return JSON.parse(await this.text())
  }

  /**
   * Replaces the content, creating the file if it is missing. The parent
   * directory is not created. A stream is consumed by the provider, and an
   * error of the stream rejects the write.
   *
   * A destination link is followed, including a dangling link. With
   * `exclusive: true`, the target is created exclusively. With `atomic`,
   * complete content is published at once, keeping the existing permission
   * bits unless `mode` is given. Requesting both requires a provider that
   * can atomically publish a new file only while its target is missing.
   * An exclusive or staged write through a link into another mount fails with `CrossesDevices`.
   */
  async write(data: WriteSource, options: WriteOptions = {}): Promise<void> {
    if (this._slices) {
      throw new TypeError(`cannot write a slice of ${this.url.href}`)
    }
    return this.fs['_write'](this.url, toStream(data), options)
  }
}

/**
 * An entry of a directory, as listed by `readdir()`: a reference to it with
 * its type at the time of the listing. A file is a `FileRef`. The type is that
 * of the entry itself, not of the target of a link, so a link to a file is an
 * `EntryRef`.
 */
export type DirEntryRef =
  | (FileRef & { readonly type: 'file' })
  | (EntryRef & { readonly type: Exclude<EntryType, 'file'> })
