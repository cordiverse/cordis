import { Context } from 'cordis'
import type {} from '@cordisjs/http'
import type {} from '@cordisjs/server'
import z from 'schemastery'

declare module '@cordisjs/server' {
  interface Server {
    proxy: ServerProxy
  }
}

export interface ServerProxy {
  /** The public URL of the proxy. */
  readonly publicUrl: string
}

export interface Config {
  target: string
}

export const Config: z<Config> = z.object({
  target: z.string().required().description('The URL to forward requests to, under which their paths are resolved.'),
})

export const name = 'server:proxy'

// The characters that `encodeURIComponent` encodes, but that RFC 3986 allows in
// a path segment: the sub-delimiters `$&+,;=`, `:` and `@`.
const segmentChars = /%(?:24|26|2B|2C|3A|3B|3D|40)/g

function encodeSegment(segment: string) {
  return encodeURIComponent(segment).replace(segmentChars, decodeURIComponent)
}

export const inject = ['http', 'server']

// The headers that describe the connection to the caller rather than the request.
// The upstream client refuses to forward a body it receives as a stream under
// `transfer-encoding`, and it frames the body itself, so these are dropped.
const hopByHop = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

function forwardHeaders(headers: Headers) {
  const result = new Headers()
  for (const [key, value] of headers) {
    if (!hopByHop.has(key.toLowerCase())) result.append(key, value)
  }
  return result
}

export function apply(ctx: Context, config: Config) {
  // the target as a directory, so that the paths of requests are resolved under it
  const target = new URL(config.target)
  target.pathname = target.pathname.replace(/\/*$/, '/')

  // The URL under the target for the path of a request, or `undefined` outside of
  // it. The router decodes the path, so each segment is encoded again, and `..`
  // remains a dot segment, which the URL parser removes.
  function locate(path = '') {
    const url = new URL('./' + path.split('/').map(encodeSegment).join('/'), target)
    if (url.origin === target.origin && url.pathname.startsWith(target.pathname)) return url
  }

  const bodyMethods = new Set(['POST', 'PUT', 'PATCH'])

  ctx.reflect.provide('server.proxy', {
    get publicUrl() {
      return ctx.server.publicUrl
    },
  } satisfies ServerProxy)

  ctx.server.all('{/*path}', async (req, res, next) => {
    const url = locate(req.params.path)
    if (!url) return new Response(null, { status: 400, statusText: 'Bad Request' })
    url.search = req.query.toString()
    ctx.logger?.debug('%s %s -> %s', req.method, req.url, url.href)
    const response = await ctx.http(url.href, {
      method: req.method as any,
      headers: forwardHeaders(req.headers),
      data: bodyMethods.has(req.method) ? req.body : undefined,
    }) as unknown as Response
    const headers = new Headers(response.headers)
    // undici already decoded the body; these headers no longer match the forwarded bytes.
    headers.delete('content-encoding')
    headers.delete('content-length')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })

  ctx.server.ws('{/*path}', async (req, accept) => {
    const httpUrl = locate(req.params.path)
    if (!httpUrl) {
      ctx.logger?.debug('WS %s is outside the target', req.url)
      return
    }
    const wsUrl = new URL(httpUrl)
    wsUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    wsUrl.search = req.query.toString()
    ctx.logger?.debug('WS %s -> %s', req.url, wsUrl.href)

    const headers: Record<string, string> = {}
    for (const [k, v] of req.headers) {
      const key = k.toLowerCase()
      if (['host', 'connection', 'upgrade', 'sec-websocket-key',
        'sec-websocket-version', 'sec-websocket-extensions',
        'sec-websocket-accept', 'content-length'].includes(key)) continue
      headers[k] = v
    }

    const upstream = ctx.http.ws(wsUrl.href, { headers })

    // WebSocket.close() spec: only 1000 or 3000-4999 are allowed from user code;
    // 1001-1015 are protocol-reserved and throw InvalidAccessError.
    const sanitizeCode = (code: number) => (code === 1000 || (code >= 3000 && code < 5000)) ? code : 1000

    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => { cleanup(); resolve() }
        const onError = () => { cleanup(); reject(new Error('upstream WebSocket error')) }
        const onClose = (e: CloseEvent) => {
          cleanup()
          reject(new Error(`upstream closed before open (code ${e.code})`))
        }
        const cleanup = () => {
          upstream.removeEventListener('open', onOpen)
          upstream.removeEventListener('error', onError)
          upstream.removeEventListener('close', onClose)
        }
        upstream.addEventListener('open', onOpen)
        upstream.addEventListener('error', onError)
        upstream.addEventListener('close', onClose)
      })
    } catch (error) {
      ctx.logger?.warn(error)
      return
    }

    const downstream = await accept()

    downstream.on('message', (data, isBinary) => {
      if (upstream.readyState !== upstream.OPEN) return
      if (isBinary) {
        const buf = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data
        upstream.send(buf)
      } else {
        upstream.send(data.toString())
      }
    })

    downstream.on('close', (code, reason) => {
      if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) {
        upstream.close(sanitizeCode(code), reason.toString())
      }
    })

    downstream.on('error', (error) => {
      ctx.logger?.warn(error)
    })

    upstream.addEventListener('message', (event) => {
      if (downstream.readyState !== downstream.OPEN) return
      const data = event.data
      if (typeof data === 'string') {
        downstream.send(data)
      } else if (data instanceof ArrayBuffer) {
        downstream.send(Buffer.from(data))
      } else if (data instanceof Blob) {
        data.arrayBuffer().then((buf) => downstream.send(Buffer.from(buf)))
      }
    })

    upstream.addEventListener('close', (event) => {
      if (downstream.readyState === downstream.OPEN || downstream.readyState === downstream.CONNECTING) {
        downstream.close(sanitizeCode(event.code), event.reason)
      }
    })

    upstream.addEventListener('error', () => {
      if (downstream.readyState === downstream.OPEN) {
        downstream.close(1011, 'upstream error')
      }
    })
  })
}
