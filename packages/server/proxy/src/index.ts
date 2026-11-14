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
  readonly baseUrl: string
}

export interface Config {
  baseUrl?: string
}

export const Config: z<Config> = z.object({
  baseUrl: z.string(),
})

export const name = 'server:proxy'

export const inject = ['http', 'server']

export function apply(ctx: Context, config: Config) {
  const upstreamBase = config.baseUrl ? config.baseUrl.replace(/\/+$/, '') + '/' : undefined
  const bodyMethods = new Set(['POST', 'PUT', 'PATCH'])

  ctx.reflect.provide('server.proxy', {
    get baseUrl() {
      return ctx.server.baseUrl
    },
  } satisfies ServerProxy)

  ctx.server.all('{/*path}', async (req, res, next) => {
    const url = new URL(req.params.path ?? '', upstreamBase)
    url.search = req.query.toString()
    ctx.logger?.debug('%s %s -> %s', req.method, req.url, url.href)
    const response = await ctx.http(url.href, {
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

  ctx.server.ws('{/*path}', async (req, accept) => {
    const httpUrl = new URL(req.params.path ?? '', upstreamBase)
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
