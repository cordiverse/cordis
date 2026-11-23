import type { ReadOptions } from './ref.ts'

// The greatest length this slice can have before the size of the input is known.
function maxLength({ start = 0, end }: ReadOptions) {
  if (end === undefined) return start < 0 ? -start : Infinity
  if (start >= 0) return end < 0 ? Infinity : Math.max(0, end - start)
  return end < 0 ? Math.max(0, end - start) : Math.min(-start, end)
}

function range(start: number, end?: number): ReadOptions {
  const slice: ReadOptions = {}
  if (start) slice.start = start
  if (end !== undefined) slice.end = end
  return slice
}

// Merges adjacent slices when both count from the start, both trim their two
// ends, or both select a suffix. Each rule holds for every input size.
function merge(first: ReadOptions, start: number, end?: number) {
  const from = first.start ?? 0
  const to = first.end
  if (from >= 0 && start >= 0) {
    if ((to ?? 0) >= 0 && (end ?? 0) >= 0) {
      const limit = to ?? Number.MAX_SAFE_INTEGER
      return range(Math.min(from + start, limit), end === undefined ? to : Math.min(from + end, limit))
    }
    if ((to ?? 0) <= 0 && (end ?? 0) <= 0) {
      const suffix = (to ?? 0) + (end ?? 0)
      return range(Math.min(from + start, Number.MAX_SAFE_INTEGER), Math.max(suffix, -Number.MAX_SAFE_INTEGER))
    }
  }
  if (from < 0 && start < 0 && to === undefined && end === undefined) {
    return range(Math.max(from, start))
  }
}

/** Appends a slice relative to the last one, without reading the file. */
export function appendSlice(slices: readonly ReadOptions[], start: number, end?: number): readonly ReadOptions[] {
  if (!start && end === undefined) return slices
  const next = range(start, end)
  const last = slices.at(-1)
  const available = last ? maxLength(last) : Infinity
  if (!maxLength(next) || !available || start >= available) return [{ end: 0 }]
  const merged = last && merge(last, start, end)
  return merged ? [...slices.slice(0, -1), merged] : [...slices, next]
}

// The absolute offset of a boundary in an input of this size.
function offset(index: number, size: number) {
  return index < 0 ? Math.max(0, size + index) : Math.min(index, size)
}

/** Resolves each slice against the length selected by the preceding slice. */
export function resolveSlices(slices: readonly ReadOptions[], size: number): ReadOptions {
  let start = 0
  let length = size
  for (const slice of slices) {
    const from = offset(slice.start ?? 0, length)
    const to = offset(slice.end ?? length, length)
    start += from
    length = Math.max(0, to - from)
  }
  return range(start, start + length)
}

interface Chunk {
  bytes: Uint8Array
  next?: Chunk
}

// Bytes retained across reads. A retained byte is copied, so that an emitted
// chunk shares no buffer with it, and a small range does not keep a large chunk.
class ByteQueue {
  private first?: Chunk
  private last?: Chunk
  length = 0

  // Keeps the last capacity bytes and releases the older bytes in order.
  retainLast(bytes: Uint8Array, capacity: number, output?: ReadableStreamDefaultController<Uint8Array>) {
    const excess = Math.max(0, this.length + bytes.length - capacity)
    const prefix = Math.max(0, excess - this.length)
    this.drain(excess, output)
    if (prefix) output?.enqueue(prefix === bytes.length ? bytes : bytes.subarray(0, prefix))
    if (prefix < bytes.length) {
      const chunk = { bytes: new Uint8Array(bytes.subarray(prefix)) }
      if (this.last) this.last.next = chunk
      else this.first = chunk
      this.last = chunk
      this.length += chunk.bytes.length
    }
    return excess
  }

  // Removes up to count bytes, emitting them when a controller is supplied.
  drain(count: number, controller?: ReadableStreamDefaultController<Uint8Array>) {
    while (count > 0 && this.first) {
      const { bytes, next } = this.first
      const length = Math.min(count, bytes.length)
      if (length < bytes.length) {
        // a copy, as the consumer owns an emitted chunk
        controller?.enqueue(bytes.slice(0, length))
        this.first.bytes = bytes.subarray(length)
      } else {
        controller?.enqueue(bytes)
        this.first = next
      }
      count -= length
      this.length -= length
    }
    if (!this.first) this.last = undefined
  }
}

/** Applies one Blob-style slice to a sequential stream. */
export function sliceStream(source: ReadableStream<Uint8Array>, { start = 0, end }: ReadOptions): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const tail = new ByteQueue()
  const absoluteEnd = end !== undefined && end >= 0 ? end : Infinity
  // With a negative start and a positive end the range becomes empty at end - start.
  const limit = absoluteEnd - Math.min(start, 0)
  let size = 0
  let cancelled = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        // Even an empty slice observes a failure to open or read the source.
        const { done, value } = await reader.read()
        if (cancelled) return
        if (done) {
          if (start < 0) {
            tail.drain(offset(end ?? size, size) - offset(start, size), controller)
          }
          return controller.close()
        }

        const position = size
        size += value.length
        const from = Math.max(0, start - position)
        const to = Math.min(size, absoluteEnd)
        const bytes = !from && to === size ? value : value.subarray(from, Math.max(0, to - position))
        // With a negative start, only [offset(start, size), to) can still contribute.
        // Bytes past a non-negative end count towards size and shorten that interval.
        const keep = start < 0 ? Math.max(0, to - offset(start, size)) : Math.max(0, -(end ?? 0))
        const output = start >= 0 ? controller : undefined
        const released = tail.retainLast(bytes, keep, output)
        if (size >= limit) {
          controller.close()
          reader.cancel().catch(() => {})
          return
        }
        if (output && released) return
      }
    },
    cancel(reason) {
      cancelled = true
      return reader.cancel(reason)
    },
  }, { highWaterMark: 0 })
}
