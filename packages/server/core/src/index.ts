import { Context, DisposableList, Fiber, Service } from 'cordis'
import { Awaitable, defineProperty, Dict, trimSlash } from 'cosmokit'
import * as http from 'node:http'
import { ExtractParams, Keys, pathToRegexp } from 'path-to-regexp-typed'
import { WebSocket, WebSocketServer } from 'ws'
import { listen, ListenOptions } from './listen.ts'
import { Request, Response, ValidationError } from './body.ts'
import z from 'schemastery'

export * from './body.ts'

declare module 'cordis' {
  interface Context {
    server: Server
  }

  interface Events {
    'server/request'(this: Server, req: Request, res: Response, next: () => Promise<void>): Promise<void>
    'server/route-check'(this: Server, req: Request, route: Route): boolean | void
    'server/route-request'(this: Server, req: Request, res: Response, route: HttpRoute, next: () => Promise<globalThis.Response | void>): Promise<globalThis.Response | void>
    'server/upgrade'(this: Server, req: Request, next: () => Promise<void>): Promise<void>
  }
}

export namespace Route {
  export interface Options {}
}

// The server accepts paths whose percent escapes are well-formed and encode valid UTF-8.
function isEncoded(path: string) {
  try {
    decodeURI(path)
    return true
  } catch {
    return false
  }
}

export abstract class Route {
  regexp: RegExp
  keys?: Keys
  config: Server.Intercept
  fiber?: Fiber

  abstract dispose: () => void

  constructor(protected server: Server, label: string, public path: string | RegExp, public options: Route.Options) {
    this.config = server[Server.resolveIntercept]()
    this.fiber = server.ctx.fiber
    const paths = [path]
    if (this.config.path) paths.unshift(this.config.path)
    server.ctx.logger?.('server:route').debug('register', label, ...paths)
    if (typeof path === 'string') {
      const { regexp, keys } = pathToRegexp(path)
      this.regexp = regexp
      this.keys = keys
    } else {
      this.regexp = path
    }
  }

  check(req: Request) {
    let pathname = req.path
    if (this.config.path) {
      if (!pathname.startsWith(this.config.path)) return
      pathname = pathname.slice(this.config.path.length)
    }
    const capture = this.regexp.exec(pathname)
    if (!capture) return
    let params: any
    if (this.keys) {
      params = {}
      for (const [index, { name }] of this.keys.entries()) {
        const value = capture[index + 1]
        if (value === undefined) continue
        try {
          params[name] = decodeURIComponent(value)
        } catch {
          // A route literal can split a percent escape or a UTF-8 sequence
          // at the capture boundary, so the route does not match the request.
          return
        }
      }
    } else {
      params = capture
    }
    this.server.ctx.logger?.('server:route').debug('match %s with params', this.path, params)
    const matched = Object.assign(Object.create(req), { params })
    if (this.server.ctx.bail(this.server, 'server/route-check', matched, this)) return
    return params
  }
}

type WsHandler<P = any> = (req: Request & { params: P }, accept: () => Promise<WebSocket>) => Awaitable<void>

export class WsRoute extends Route {
  clients = new Set<WebSocket>()
  dispose: () => void

  constructor(server: Server, path: string | RegExp, public handle?: WsHandler, options: Route.Options = {}) {
    super(server, 'WS', path, options)
    const self = this
    this.dispose = server.ctx.effect(function* () {
      yield server.wsRoutes.push(self)
      yield () => {
        for (const socket of self.clients) {
          socket.close()
        }
      }
    }, `ctx.server.ws(${typeof path === 'string' ? JSON.stringify(path) : path})`)
  }
}

export type Middleware<P = any> = (req: Request & { params: P }, res: Response, next: () => Promise<globalThis.Response | void>) => Promise<globalThis.Response | void>

export class HttpRoute extends Route {
  dispose: () => void

  constructor(server: Server, public method: string, path: string | RegExp, public callback: Middleware, options: Route.Options = {}) {
    super(server, method, path, options)
    const key = typeof path === 'string' ? `${method.toUpperCase()} ${path}` : undefined
    if (key) {
      Object.assign(this.options, this.config.routes?.[key])
    }
    const self = this
    this.dispose = server.ctx.effect(function* () {
      yield server.httpRoutes.push(self)
    }, `ctx.server.${method}(${typeof path === 'string' ? JSON.stringify(path) : path})`)
  }
}

interface RouteImpl {
  <P extends string>(path: P, middleware: Middleware<ExtractParams<P>>, options?: Route.Options): HttpRoute
  (path: RegExp, middleware: Middleware<RegExpExecArray>, options?: Route.Options): HttpRoute
  (path: string | RegExp, middleware: Middleware, options?: Route.Options): HttpRoute
}

interface Server extends Record<typeof Server.methods[number], RouteImpl> {}

class Server extends Service<Server.Intercept> {
  static readonly methods = ['all', 'get', 'delete', 'head', 'post', 'put', 'patch'] as const

  static {
    for (const method of Server.methods) {
      defineProperty(Server.prototype, method, function (this: Server, path: string | RegExp, middleware: Middleware, options?: Route.Options) {
        return new HttpRoute(this, method, path, middleware, options)
      })
    }
  }

  Config: z<Server.Intercept> = z.object({
    path: z.string().description('The path prefix of the routes registered in this context, which is also appended to `publicUrl`.'),
    routes: z.dict(z.any()).hidden(),
  })

  public _http: http.Server
  public _ws: WebSocketServer
  public httpRoutes = new DisposableList<HttpRoute>()
  public wsRoutes = new DisposableList<WsRoute>()

  public host!: string
  public port!: number

  constructor(public ctx: Context, public config: Server.Config) {
    super(ctx, 'server')

    this._http = http.createServer()

    this._http.on('request', async (_req, _res) => {
      const req = new Request(_req)
      const res = new Response(_res)
      this.ctx.logger?.('server:request').debug('%C %s', req.method, req.url)
      _res.on('finish', () => {
        this.ctx.logger?.('server:response').debug('%C %s %s %s', req.method, req.url, res.status, res.statusText)
      })
      try {
        if (isEncoded(req.path)) {
          await this.ctx.waterfall(this, 'server/request', req, res, async () => {})
        } else {
          res.status = 400
        }
      } catch (error) {
        if (error instanceof ValidationError) {
          if (!res.claimed) {
            res.status = 422
            res.json({ issues: error.issues })
          }
        } else {
          this.ctx.logger?.error(error)
          if (!res.claimed) {
            res.status = 500
          }
        }
      }
      res._end()
    })

    this.ctx.on('server/request', async (req, res, next) => {
      const method = req.method.toLowerCase()
      const routes = [...this.httpRoutes]
      // A HEAD request is served by a GET route, but an explicit HEAD route wins.
      // Move only explicit HEAD routes and keep the original order of the rest,
      // so GET and HEAD reach the same handler when an `all` route also matches.
      if (method === 'head') {
        routes.sort((a, b) => Number(b.method === 'head') - Number(a.method === 'head'))
      }
      const runRoute = async (index: number): Promise<globalThis.Response | void> => {
        for (let i = index; i < routes.length; i++) {
          const route = routes[i]
          if (route.method !== 'all' && method !== route.method && !(method === 'head' && route.method === 'get')) continue
          const params = route.check(req)
          if (!params) continue
          const matched = Object.assign(Object.create(req), { params })
          return this.ctx.waterfall(this, 'server/route-request', matched, res, route, () => {
            return route.callback(matched, res, () => runRoute(i + 1))
          })
        }
        await next()
      }
      const response = await runRoute(0)
      if (response) {
        res.body = response.body
        res.status = response.status
        for (const [key, value] of response.headers) {
          res.headers.set(key, value)
        }
      }

      if (res.claimed) return
      const methods = new Set<string>()
      let asterisk = false
      for (const route of this.httpRoutes) {
        if (!route.check(req)) continue
        if (route.method === 'all') {
          asterisk = true
          break
        }
        methods.add(route.method)
        if (route.method === 'get') methods.add('head')
      }
      if (!methods.size && !asterisk) {
        res.status = 404
      } else {
        const allow = asterisk ? '*' : [...methods].join(', ')
        if (req.method === 'OPTIONS') {
          res.status = 204
        } else {
          res.status = 405
        }
        res.headers.set('allow', allow)
      }
    })

    this._ws = new WebSocketServer({ noServer: true })

    this._http.on('upgrade', async (_req, socket, head) => {
      const req = new Request(_req)
      if (!isEncoded(req.path)) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        socket.destroy()
        return
      }
      this.ctx.logger?.('server:ws').debug('upgrade %s', req.path)
      await this.ctx.waterfall(this, 'server/upgrade', req, async () => {
        for (const route of this.wsRoutes) {
          const params = route.check(req)
          if (!params) continue
          const matched = Object.assign(Object.create(req), { params })
          let connection: WebSocket | undefined
          const accept = () => new Promise<WebSocket>((resolve) => {
            // handleUpgrade calls the callback synchronously upon success
            this._ws.handleUpgrade(_req, socket, head, (ws) => {
              connection = ws
              this._ws.emit('connection', ws, _req)
              route.clients.add(ws)
              ws.on('close', () => {
                route.clients.delete(ws)
                this.ctx.logger?.('server:ws').debug('close %s', req.path)
              })
              this.ctx.logger?.('server:ws').debug('accept %s', req.path)
              resolve(ws)
            })
          })
          if (!route.handle) {
            await accept()
            return
          }
          try {
            await route.handle(matched, accept)
          } catch (error) {
            this.ctx.logger?.error(error)
            if (connection) {
              connection.close()
            } else if (!socket.destroyed) {
              socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
              socket.destroy()
            }
          }
          if (!connection && !socket.destroyed) {
            this.ctx.logger?.('server:ws').warn('ws handler for %s did not call accept()', req.path)
            socket.destroy()
          }
          return
        }
        this.ctx.logger?.('server:ws').debug('refuse %s', req.path)
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
      })
    })

    if (config.publicUrl) {
      config.publicUrl = trimSlash(config.publicUrl)
    }
  }

  async* [Service.init]() {
    this.host = this.config.host
    this.port = await listen(this._http, this.config)
    yield () => new Promise<void>((resolve, reject) => {
      this._http.close((err) => err ? reject(err) : resolve())
    })
    this.ctx.logger?.info('server listening at %C', `http://${this.host}:${this.port}`)
    yield () => this.ctx.logger?.info(`server closing at %C`, `http://${this.host}:${this.port}`)
  }

  /** The public URL of the routes in this context, with the path prefix of its intercepts. */
  get publicUrl() {
    const intercept = this[Service.resolveIntercept]()
    const pathPrefix = intercept.path ?? ''
    if (this.config.publicUrl) return this.config.publicUrl + pathPrefix
    const wildcard = ['0.0.0.0', '::']
    const host = wildcard.includes(this.host) ? '127.0.0.1' : this.host
    let root: string
    if (this.port === 80) {
      root = `http://${host}`
    } else if (this.port === 443) {
      root = `https://${host}`
    } else {
      root = `http://${host}:${this.port}`
    }
    return root + pathPrefix
  }

  use(middleware: (req: Request, res: Response, next: () => Promise<void>) => Promise<void>) {
    return this.ctx.on('server/request', middleware, { prepend: true })
  }

  ws<P extends string>(path: P, callback?: WsHandler<ExtractParams<P>>, options?: Route.Options): WsRoute
  ws(path: RegExp, callback?: WsHandler<RegExpExecArray>, options?: Route.Options): WsRoute
  ws(path: string | RegExp, callback?: WsHandler, options?: Route.Options) {
    return new WsRoute(this, path, callback, options)
  }
}

namespace Server {
  export interface Intercept {
    path?: string
    routes?: Dict<Route.Options>
  }

  export interface Config extends ListenOptions {
    host: string
    port: number
    maxPort?: number
    publicUrl?: string
  }

  export const Config: z<Config> = z.object({
    host: z.string().default('127.0.0.1').description('The IP address to listen on. `0.0.0.0` listens on all addresses, including those of the local network and the public network.'),
    port: z.natural().required().max(65535).description('The first port to try.'),
    maxPort: z.natural().max(65535).description('The last port to try. A port that is in use or denied is skipped for the next one. Defaults to `port`.'),
    publicUrl: z.string().role('link').description('The public URL of the server. Defaults to the URL of the address that the server listens on.'),
  })
}

export { Server }
export default Server
