import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import Http, { parseEventStream, ServerSentEvent } from '../src/index.ts'

function encode(chunks: string[]) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(chunks: string[]) {
  const events: ServerSentEvent[] = []
  for await (const event of parseEventStream(encode(chunks))) events.push(event)
  return events
}

describe('parseEventStream()', () => {
  it('parses fields and joins data lines', async () => {
    expect(await collect(['event: update\ndata: foo\ndata:bar\nid: 1\n\n'])).to.deep.equal([
      { event: 'update', data: 'foo\nbar', id: '1' },
    ])
  })

  it('uses `message` as the default event type and keeps the last event ID', async () => {
    expect(await collect(['id: 1\ndata: a\n\ndata: b\n\nid\ndata: c\n\n'])).to.deep.equal([
      { event: 'message', data: 'a', id: '1' },
      { event: 'message', data: 'b', id: '1' },
      { event: 'message', data: 'c', id: '' },
    ])
  })

  it('ignores comments, unknown fields and events without data', async () => {
    expect(await collect([': ping\n\nevent: x\nfoo: bar\n\ndata\n\n'])).to.deep.equal([
      { event: 'message', data: '', id: '' },
    ])
  })

  it('accepts CRLF, CR and LF line ends across chunk boundaries', async () => {
    expect(await collect(['data: a\r', '\n\r', '\ndata: b\r\rdata: c\n', '\n'])).to.deep.equal([
      { event: 'message', data: 'a', id: '' },
      { event: 'message', data: 'b', id: '' },
      { event: 'message', data: 'c', id: '' },
    ])
  })

  it('decodes multi-byte characters split across chunks and removes a byte order mark', async () => {
    const bytes = new TextEncoder().encode('\uFEFFdata: 你好\n\n')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    })
    const events: ServerSentEvent[] = []
    for await (const event of parseEventStream(body)) events.push(event)
    expect(events).to.deep.equal([{ event: 'message', data: '你好', id: '' }])
  })

  it('reports the last valid reconnection time', async () => {
    expect(await collect(['data: a\n\nretry: 1000\ndata: b\n\nretry: 1s\ndata: c\n\n'])).to.deep.equal([
      { event: 'message', data: 'a', id: '' },
      { event: 'message', data: 'b', id: '', retry: 1000 },
      { event: 'message', data: 'c', id: '', retry: 1000 },
    ])
  })

  it('ignores an ID that contains NULL', async () => {
    expect(await collect(['id: 1\ndata: a\n\nid: 2\0\ndata: b\n\n'])).to.deep.equal([
      { event: 'message', data: 'a', id: '1' },
      { event: 'message', data: 'b', id: '1' },
    ])
  })

  it('discards an unterminated event at the end of the body', async () => {
    expect(await collect(['data: a\n\ndata: b\n'])).to.deep.equal([
      { event: 'message', data: 'a', id: '' },
    ])
  })
})

describe('responseType: event-stream', () => {
  let ctx: Context
  let server: Server
  let url: string
  let closed: Promise<void>

  beforeEach(async () => {
    let onClose!: () => void
    closed = new Promise((resolve) => onClose = resolve)
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
      res.on('close', onClose)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    ctx = new Context()
    await ctx.use(Http)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  it('delivers events before the response ends and closes the connection when cancelled', async () => {
    const stream = await ctx.http.get(url, { responseType: 'event-stream' })
    const reader = stream.getReader()
    expect((await reader.read()).value).to.deep.equal({ event: 'message', data: 'first', id: '' })
    await reader.cancel()
    await closed
  })
})
