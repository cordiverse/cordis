import type { Fs } from './index.ts'

/** The data accepted by `FileRef.write()`. A string is encoded as UTF-8. */
export type WriteSource = string | ArrayBuffer | ArrayBufferView<ArrayBuffer> | Blob | ReadableStream<Uint8Array>

function toStream(data: WriteSource): ReadableStream<Uint8Array> {
  if (data instanceof ReadableStream) return data
  return new Blob([data]).stream()
}

/** A reference to a file. Creating it performs no I/O. */
export class FileRef {
  constructor(private fs: Fs, public readonly url: URL) {}

  /**
   * Returns a stream of the current content. A failure of the provider,
   * including a missing file, errors the stream.
   */
  stream(): ReadableStream<Uint8Array> {
    return this.fs['_provider'](this.url, 'read').read(this.url)
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
   */
  async write(data: WriteSource): Promise<void> {
    return this.fs['_provider'](this.url, 'write').write(this.url, toStream(data))
  }
}
