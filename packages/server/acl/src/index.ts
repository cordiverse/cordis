import { Context } from 'cordis'
import type {} from '@cordisjs/server'
import z from 'schemastery'

declare module '@cordisjs/server' {
  namespace Route {
    interface Options {
      allowedHosts?: boolean | string[]
    }
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function stripPort(host: string): string {
  host = host.toLowerCase()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end >= 0 ? host.slice(0, end + 1) : host
  }
  const i = host.indexOf(':')
  return i >= 0 ? host.slice(0, i) : host
}

function matchHost(pattern: string, host: string): boolean {
  pattern = pattern.toLowerCase()
  if (pattern.startsWith('.')) {
    return host === pattern.slice(1) || host.endsWith(pattern)
  }
  return pattern === host
}

function isAllowed(allowed: boolean | string[] | undefined, hostHeader: string | null | undefined): boolean {
  if (allowed === undefined || allowed === true) return true
  const host = stripPort(hostHeader ?? '')
  if (LOOPBACK_HOSTS.has(host)) return true
  if (allowed === false) return false
  return allowed.some((p) => matchHost(p, host))
}

export interface Config {
  allowedHosts?: boolean | string[]
}

export const Config: z<Config> = z.object({
  allowedHosts: z.union([
    z.boolean(),
    z.array(String),
  ]).description('允许访问的 Host 列表。`true` 表示任意 Host；`false` 表示仅允许本地回环；字符串数组为显式白名单（本地回环始终允许）。支持 `.example.com` 形式的子域通配。'),
})

export const name = 'server:acl'

export const inject = ['server']

export function apply(ctx: Context, config: Config) {
  ctx.on('server/route-check', (req, route) => {
    const allowed = route.options.allowedHosts ?? config.allowedHosts
    const host = req.headers.get('host')
    if (!isAllowed(allowed, host)) {
      ctx.logger?.debug('skip %s (host=%s)', req.url, host)
      return true
    }
  })
}
