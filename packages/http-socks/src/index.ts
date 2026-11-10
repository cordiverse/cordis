// modified from https://github.com/Kaciras/fetch-socks/blob/41cec5a02c36687279ad2628f7c46327f7ff3e2d/index.ts

import type {} from '@cordisjs/http'
import { lookup } from 'node:dns/promises'
import { Context } from 'cordis'
import { SocksClient, SocksProxy } from 'socks'
import type { buildConnector } from 'undici'

export const name = 'http-socks'
export const inject = ['http']

export function apply(ctx: Context) {
  ctx.http.proxy(['socks', 'socks4', 'socks4a', 'socks5', 'socks5h'], (url) => {
    let shouldLookup = false
    let type: SocksProxy['type']

    // From RFC 1928, Section 3: https://tools.ietf.org/html/rfc1928#section-3
    // "The SOCKS service is conventionally located on TCP port 1080"
    const port = parseInt(url.port, 10) || 1080
    const host = url.hostname

    // figure out if we want socks v4 or v5, based on the "protocol" used.
    // Defaults to 5.
    switch (url.protocol.slice(0, -1)) {
      case 'socks4':
        shouldLookup = true
      // eslint-disable-next-line no-fallthrough
      case 'socks4a':
        type = 4
        break
      case 'socks5':
        shouldLookup = true
      // eslint-disable-next-line no-fallthrough
      case 'socks':
      case 'socks5h':
        type = 5
        break
      default:
        throw new Error('unreachable')
    }

    const proxy: SocksProxy = { host, port, type }
    if (url.username) proxy.userId = decodeURIComponent(url.username)
    if (url.password) proxy.password = decodeURIComponent(url.password)
    return new ctx.http.undici.Agent({ connect: createConnect(proxy, shouldLookup) })
  })

  function resolvePort(protocol: string, port: string) {
    return port ? Number.parseInt(port) : protocol === 'http:' ? 80 : 443
  }

  function createConnect(proxy: SocksProxy, shouldLookup: boolean, tlsOpts: buildConnector.BuildOptions = {}): buildConnector.connector {
    const { timeout = 10e3 } = tlsOpts
    const connect = ctx.http.undici.buildConnector(tlsOpts)

    return async (options, callback) => {
      let { protocol, hostname, port, httpSocket } = options

      try {
        if (shouldLookup) {
          hostname = (await lookup(hostname)).address
        }
        const event = await SocksClient.createConnection({
          command: 'connect',
          proxy,
          timeout,
          destination: {
            host: hostname,
            port: resolvePort(protocol, port),
          },
          existing_socket: httpSocket,
        })
        httpSocket = event.socket
      } catch (error: any) {
        return callback(error, null)
      }

      if (httpSocket && protocol !== 'https:') {
        return callback(null, httpSocket.setNoDelay())
      }

      return connect({ ...options, httpSocket }, callback)
    }
  }
}
