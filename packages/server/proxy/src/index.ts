import { Context, Service } from 'cordis'
import type {} from '@cordisjs/http'
import type { Request } from '@cordisjs/server'
import z from 'schemastery'

export interface Config {
  target: string
  isolateOrigin?: boolean
  requestHeaders?: Record<string, string>
}

const headerName = z.string().pattern(/^[!#$%&'*+.^_`|~\w-]+$/).required()

export const Config: z<Config> = z.object({
  target: z.string()
    .pattern(/^(?:https?:(?:\/\/[^/?#]+(?:\/[^?#]*)?\/)?)?$/i)
    .required()
    .description('The prefix of the forwarded URLs: a URL ending with `/`, a scheme such as `https:`, or the empty string for every HTTP URL. A request is forwarded to the prefix followed by its path under the routes, such as `https://example.com/api/` with `/users` to `https://example.com/api/users`.'),
  isolateOrigin: z.boolean().default(false).description('Filter the incoming Cookie header, remove Set-Cookie and Clear-Site-Data from upstream responses, and sandbox upstream documents.'),
  requestHeaders: z.dict(headerName, headerName).description('Maps each upstream request header to its sole incoming source. Source headers are consumed. A missing source omits the upstream header. Names are case-insensitive. Headers reserved by the proxy cannot be mapped.'),
})

export const name = 'server:proxy'

export const inject = ['std:http', 'std:server']

const schemeRegExp = /^[a-z][a-z\d+.-]*:$/i

const hopByHopHeaders = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]
// The upstream client supplies its own Host and handles the request body.
const reservedRequestHeaders = new Set([...hopByHopHeaders, 'host', 'expect'])
const wsHandshakeHeaders = [
  ...reservedRequestHeaders,
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions',
  'sec-websocket-accept', 'content-length',
]
// Undici decodes the body, so its upstream encoding and length no longer describe it.
const reservedResponseHeaders = [...hopByHopHeaders, 'content-encoding', 'content-length']

function blockedHeaders(incoming: Headers, reserved: Iterable<string>) {
  const blocked = new Set(reserved)
  for (const field of incoming.get('connection')?.split(',') ?? []) {
    blocked.add(field.trim().toLowerCase())
  }
  return blocked
}

export function apply(ctx: Context, config: Config) {
  // Whether a URL lies under the target, as `ctx.std.fs.mount()` matches a prefix:
  // the empty string contains every URL, a scheme the URLs of that scheme, and
  // a URL the URLs that start with it. Below a URL, the forwarded URL and the
  // target are also compared with their encoded separators decoded, as an
  // upstream that decodes them before it normalizes the path would take
  // `..%2F` out of the target.
  let contains: (url: URL) => boolean
  if (config.target === '') {
    contains = () => true
  } else if (schemeRegExp.test(config.target)) {
    const protocol = config.target.toLowerCase()
    contains = url => url.protocol === protocol
  } else {
    const decode = (url: URL) => new URL(url.origin + url.pathname.replace(/%2f|%5c/gi, '/')).href
    const target = new URL(config.target)
    const decoded = decode(target)
    contains = url => url.href.startsWith(target.href) && decode(url).startsWith(decoded)
  }

  // the path prefix of the routes, which the router removes before it matches them
  const prefix = ctx.std.server[Service.resolveIntercept]().path ?? ''

  // The URL of a request under the target with one of `protocols`, or
  // `undefined` otherwise. The path is taken as the client sent it, without
  // decoding, and the forwarded URL is the target followed by the path under
  // the routes, without its leading `/`, and the query. The parser removes dot
  // segments, which may lead out of the target.
  function locate(req: Request, protocols: string[]) {
    const path = req.path.slice(prefix.length).replace(/^\//, '')
    let url: URL
    try {
      url = new URL(config.target + path + req.url.slice(req.path.length))
    } catch {
      return
    }
    if (contains(url) && protocols.includes(url.protocol)) return url
  }

  const bodyMethods = new Set(['POST', 'PUT', 'PATCH'])

  const sources = new Map<string, string>()
  for (const [name, source] of Object.entries(config.requestHeaders ?? {})) {
    const output = name.toLowerCase()
    const input = source.toLowerCase()
    const reserved = [output, input].find(field => reservedRequestHeaders.has(field))
    if (reserved) {
      throw new TypeError(`Invalid requestHeaders mapping "${name}" from "${source}": "${reserved}" is reserved by the proxy.`)
    }
    if (input === 'cookie' && config.isolateOrigin) {
      throw new TypeError(`Invalid requestHeaders mapping "${name}" from "${source}": isolateOrigin filters the incoming Cookie header.`)
    }
    sources.set(output, input)
  }
  const skipPassthrough = new Set([...sources.keys(), ...sources.values()])
  if (config.isolateOrigin) skipPassthrough.add('cookie')

  function forwardRequestHeaders(incoming: Headers, reserved: Iterable<string> = reservedRequestHeaders) {
    const blocked = blockedHeaders(incoming, reserved)
    const headers = new Headers()
    for (const [name, value] of incoming) {
      if (!blocked.has(name) && !skipPassthrough.has(name)) headers.append(name, value)
    }
    // Read all mappings from the original request so their order has no effect.
    for (const [name, source] of sources) {
      if (blocked.has(name) || blocked.has(source)) continue
      const value = incoming.get(source)
      if (value !== null) headers.set(name, value)
    }
    return headers
  }

  ctx.std.server.all('{/*path}', async (req, res, next) => {
    const url = locate(req, ['http:', 'https:'])
    if (!url) return new Response(null, { status: 400, statusText: 'Bad Request' })
    ctx.logger?.debug('%s %s -> %s', req.method, req.url, url.href)
    const response = await ctx.std.http(url.href, {
      method: req.method as any,
      headers: forwardRequestHeaders(req.headers),
      data: bodyMethods.has(req.method) ? req.body : undefined,
      // a redirect is the upstream's answer, which the caller follows by itself
      redirect: 'manual',
    }) as unknown as Response
    const blocked = blockedHeaders(response.headers, reservedResponseHeaders)
    const headers = new Headers()
    for (const [name, value] of response.headers) {
      if (!blocked.has(name)) headers.append(name, value)
    }
    if (config.isolateOrigin) {
      headers.delete('set-cookie')
      headers.delete('clear-site-data')
      // A document of the upstream runs in an opaque origin.
      headers.append('content-security-policy', 'sandbox')
      headers.set('x-content-type-options', 'nosniff')
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })

  ctx.std.server.ws('{/*path}', async (req, accept) => {
    const wsUrl = locate(req, ['http:', 'https:', 'ws:', 'wss:'])
    if (!wsUrl) {
      ctx.logger?.debug('WS %s is outside the target', req.url)
      return
    }
    wsUrl.protocol = wsUrl.protocol.replace(/^http/, 'ws')
    ctx.logger?.debug('WS %s -> %s', req.url, wsUrl.href)

    const headers = forwardRequestHeaders(req.headers, wsHandshakeHeaders)
    const upstream = ctx.std.http.ws(wsUrl.href, { headers })

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
