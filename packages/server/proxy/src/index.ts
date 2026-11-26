import { Context } from 'cordis'
import type {} from '@cordisjs/http'
import type { Request } from '@cordisjs/server'
import z from 'schemastery'

export interface Config {
  target: string
}

export const Config: z<Config> = z.object({
  target: z.string()
    .pattern(/^(?:https?:(?:\/\/[^/?#]+(?:\/[^?#]*)?\/)?)?$/i)
    .required()
    .description('The prefix of the forwarded URLs: a URL ending with `/`, a scheme such as `https:`, or the empty string for every HTTP URL. A request is forwarded to the prefix followed by its path under the routes, such as `https://example.com/api/` with `/users` to `https://example.com/api/users`.'),
})

export const name = 'server:proxy'

export const inject = ['std:http', 'std:server']

const schemeRegExp = /^[a-z][a-z\d+.-]*:$/i

export function apply(ctx: Context, config: Config) {
  // whether a URL lies under the target, as `ctx.std.fs.mount()` matches a prefix:
  // the empty string contains every URL, a scheme the URLs of that scheme,
  // and a URL the URLs that start with it
  let contains: (url: URL) => boolean
  if (config.target === '') {
    contains = () => true
  } else if (schemeRegExp.test(config.target)) {
    const protocol = config.target.toLowerCase()
    contains = url => url.protocol === protocol
  } else {
    const { href } = new URL(config.target)
    contains = url => url.href.startsWith(href)
  }

  // The URL of a request under the target with one of `protocols`, or
  // `undefined` otherwise. The path is taken as the client sent it, without
  // decoding, and the forwarded URL is the target followed by the path and the
  // query. The parser removes dot segments, which may lead out of the target.
  function locate(req: Request & { params: RegExpExecArray }, protocols: string[]) {
    let url: URL
    try {
      url = new URL(config.target + (req.params[1] ?? '') + req.url.slice(req.path.length))
    } catch {
      return
    }
    if (contains(url) && protocols.includes(url.protocol)) return url
  }

  const bodyMethods = new Set(['POST', 'PUT', 'PATCH'])

  // the path under the routes, without its leading `/`
  const route = /^(?:\/(.*))?$/s

  ctx.std.server.all(route, async (req, res, next) => {
    const url = locate(req, ['http:', 'https:'])
    if (!url) return new Response(null, { status: 400, statusText: 'Bad Request' })
    ctx.logger?.debug('%s %s -> %s', req.method, req.url, url.href)
    const response = await ctx.std.http(url.href, {
      method: req.method as any,
      headers: req.headers,
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

  ctx.std.server.ws(route, async (req, accept) => {
    const wsUrl = locate(req, ['http:', 'https:', 'ws:', 'wss:'])
    if (!wsUrl) {
      ctx.logger?.debug('WS %s is outside the target', req.url)
      return
    }
    wsUrl.protocol = wsUrl.protocol.replace(/^http/, 'ws')
    ctx.logger?.debug('WS %s -> %s', req.url, wsUrl.href)

    const headers: Record<string, string> = {}
    for (const [k, v] of req.headers) {
      const key = k.toLowerCase()
      if (['host', 'connection', 'upgrade', 'sec-websocket-key',
        'sec-websocket-version', 'sec-websocket-extensions',
        'sec-websocket-accept', 'content-length'].includes(key)) continue
      headers[k] = v
    }

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
