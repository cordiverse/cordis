/**
 * An event of a `text/event-stream` response.
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html
 */
export interface ServerSentEvent {
  /** the `event` field of the event, or `message` if it has none */
  event: string
  /** the `data` fields of the event, joined by line feeds */
  data: string
  /** the last event ID, which the `id` field of this or a previous event sets */
  id: string
  /** the reconnection time in milliseconds, which the last valid `retry` field before the event sets */
  retry?: number
}

/**
 * Parses a `text/event-stream` body into its events, according to the
 * interpretation of the WHATWG HTML Standard. An event is enqueued when the
 * blank line that ends it is received; an unterminated event at the end of
 * the body is discarded. Cancelling the result cancels the body.
 */
export function parseEventStream(body: ReadableStream<Uint8Array> | null): ReadableStream<ServerSentEvent> {
  if (!body) return new ReadableStream({ start: (controller) => controller.close() })

  // the pieces of the line that has not ended yet
  let pending: string[] = []
  // whether the previous chunk ended with CR, so that a leading LF of the next chunk belongs to the same line end
  let skipLF = false
  let event = ''
  let data = ''
  let hasData = false
  let id = ''
  let retry: number | undefined

  function processLine(line: string, controller: TransformStreamDefaultController<ServerSentEvent>) {
    if (!line) {
      if (hasData) {
        controller.enqueue({ event: event || 'message', data, id, ...retry === undefined ? {} : { retry } })
      }
      event = ''
      data = ''
      hasData = false
      return
    }
    if (line.startsWith(':')) return
    const index = line.indexOf(':')
    const field = index < 0 ? line : line.slice(0, index)
    let value = index < 0 ? '' : line.slice(index + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') {
      event = value
    } else if (field === 'data') {
      data = hasData ? data + '\n' + value : value
      hasData = true
    } else if (field === 'id') {
      if (!value.includes('\0')) id = value
    } else if (field === 'retry') {
      if (/^\d+$/.test(value)) retry = Number(value)
    }
  }

  // removes a leading byte order mark, and keeps an incomplete character for the next chunk
  const decoder = new TextDecoder()

  return body.pipeThrough(new TransformStream<Uint8Array, ServerSentEvent>({
    transform(bytes, controller) {
      let chunk = decoder.decode(bytes, { stream: true })
      if (!chunk) return
      if (skipLF && chunk.startsWith('\n')) chunk = chunk.slice(1)
      skipLF = false
      // only the new chunk is scanned, so that a line received in many chunks is scanned once
      let start = 0
      for (const match of chunk.matchAll(/\r\n|\r|\n/g)) {
        pending.push(chunk.slice(start, match.index))
        processLine(pending.join(''), controller)
        pending = []
        start = match.index + match[0].length
      }
      if (start < chunk.length) pending.push(chunk.slice(start))
      skipLF = chunk.endsWith('\r')
    },
  }))
}
