import { Context } from 'cordis'
import fetchFile from '@cordisjs/fetch-file'
import type {} from '@cordisjs/server'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { Dict } from 'cosmokit'
import picomatch from 'picomatch'
import z from 'schemastery'

export interface Config {
  root: string
  download?: boolean
  fallthrough?: boolean
  exclude: string[]
  index: string[]
  redirect: boolean
  extensions: string[]
  errorPages: Dict<string>
}

export const Config: z<Config> = z.object({
  root: z.string().required(),
  download: z.boolean(),
  fallthrough: z.boolean(),
  exclude: z.array(String),
  index: z.array(String).default(['index.html', 'index.htm']),
  redirect: z.boolean().default(true),
  extensions: z.array(String),
  errorPages: z.dict(String),
})

export const name = 'server:static'

export const inject = ['server']

export function apply(ctx: Context, config: Config) {
  const baseDir = fileURLToPath(new URL(config.root, ctx.baseUrl)).replace(/\/+$/, '')
  const isExcluded = config.exclude.length ? picomatch(config.exclude, { dot: true }) : () => false

  function _fetchFile(filename: string) {
    return fetchFile(pathToFileURL(filename), {}, {
      download: config.download,
      onError: ctx.logger?.warn,
    })
  }

  async function _tryFile(filename: string) {
    const rel = filename.slice(baseDir.length + 1)
    let response = new Response(null, { status: 404, statusText: 'Not Found' })
    if (!isExcluded(rel)) {
      response = await _fetchFile(filename)
      if (response.ok) return response
    }
    for (const ext of config.extensions) {
      if (isExcluded(rel + ext)) continue
      const response = await _fetchFile(filename + ext)
      if (response.ok) return response
    }
    return response
  }

  ctx.server.get('{/*path}', async (req, res, next) => {
    const path = req.params.path?.replace(/^\/+/, '') ?? ''
    const filename = resolve(baseDir, path)
    let status: number, statusText: string
    if (filename !== baseDir && !filename.startsWith(baseDir + '/')) {
      status = 403
      statusText = 'Forbidden'
    } else if (!path || path.endsWith('/')) {
      status = 404
      statusText = 'Not Found'
      for (const index of config.index) {
        const response = await _tryFile(resolve(baseDir, path + index))
        if (response.ok) return response
      }
    } else {
      const response = await _tryFile(filename)
      if (response.ok) return response
      status = response.status
      statusText = response.statusText
      if (response[fetchFile.kError]?.code === 'EISDIR' && config.redirect && !req.path.endsWith('/')) {
        return new Response(null, {
          status: 301,
          statusText: 'Moved Permanently',
          headers: { Location: req.path + '/' },
        })
      }
    }
    if (status === 404 && config.fallthrough) return next()
    const errorPagePath = config.errorPages[status]
    if (errorPagePath) {
      const errorPage = await fetchFile(pathToFileURL(resolve(baseDir, errorPagePath)), {}, {
        onError: ctx.logger?.warn,
      })
      if (errorPage.ok) {
        return new Response(errorPage.body, {
          status,
          statusText,
          headers: errorPage.headers,
        })
      }
    }
    return new Response(null, { status, statusText })
  })
}
