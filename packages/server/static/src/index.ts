import { Context } from 'cordis'
import { FsError } from '@cordisjs/fs'
import type {} from '@cordisjs/server'
import { Dict } from 'cosmokit'
import { fileTypeFromStream } from 'file-type'
import { contentType } from 'mime-types'
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

export const inject = ['server', 'fs']

// encodes each segment of a decoded path, keeping `.` and `..` as dot segments
function encodePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/')
}

// The status of a location that cannot be served. A location that is excluded
// or that names no readable file has no error.
function getStatus(error?: FsError): [status: number, statusText: string] {
  switch (error?.code) {
    case undefined:
    case 'NotFound':
    case 'NotADirectory':
    case 'IsADirectory':
    case 'InvalidPath':
      return [404, 'Not Found']
    case 'PermissionDenied':
      return [403, 'Forbidden']
    default:
      return [500, 'Internal Server Error']
  }
}

export function apply(ctx: Context, config: Config) {
  const resolved = ctx.fs.resolve(config.root)
  // the root as a directory, which contains every location that is served
  const root = new URL(resolved.href.endsWith('/') ? resolved.href : resolved.href + '/')
  const isExcluded = config.exclude.length ? picomatch(config.exclude, { dot: true }) : () => false

  // The location of a path under the root, or `undefined` outside of it. The
  // URL parser removes the dot segments, so the containment holds on every platform.
  function locate(path: string, base = root) {
    const url = new URL(encodePath(path), base)
    if (url.href.startsWith(root.href)) return url
  }

  // the path of a location relative to the root, which the exclude patterns match
  function relativePath(url: URL) {
    return decodeURIComponent(url.pathname.slice(root.pathname.length))
  }

  // The MIME type of the content of a file. The detection reads a stream of its
  // own, so that it may read beyond any chunk, and the reader is cancelled once
  // the detection ends. A failed detection leaves the type to the file name.
  async function detectType(url: URL) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const source = reader = ctx.fs.file(url).stream().getReader()
      const probe = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await source.read()
          if (done) return controller.close()
          controller.enqueue(value)
        },
      })
      return (await fileTypeFromStream(probe))?.mime
    } catch {
      return undefined
    } finally {
      await reader?.cancel().catch(() => {})
    }
  }

  // The response of a file, or the error that prevents reading it. The status is
  // known only after the first chunk, since a provider reports a failure through
  // the stream. `download` sets the content disposition when it is given.
  async function read(url: URL, download?: boolean): Promise<Response | FsError> {
    let reader: ReadableStreamDefaultReader<Uint8Array>
    let first: ReadableStreamReadResult<Uint8Array>
    try {
      reader = ctx.fs.file(url).stream().getReader()
      first = await reader.read()
    } catch (error) {
      if (!(error instanceof FsError)) throw error
      if (getStatus(error)[0] === 500) ctx.logger?.warn(error)
      return error
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (first.done) return controller.close()
        controller.enqueue(first.value)
      },
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) return controller.close()
        controller.enqueue(value)
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    })
    const filename = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1))
    const mime = first.done ? undefined : await detectType(url)
    const headers = new Headers({
      'content-type': mime || contentType(filename) || 'application/octet-stream',
    })
    if (download === true) {
      headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    } else if (download === false) {
      headers.set('content-disposition', 'inline')
    }
    return new Response(body, { status: 200, statusText: 'OK', headers })
  }

  // A file and its alternatives with the configured extensions. The error is
  // that of the file itself, and absent if it is excluded.
  async function tryFile(url: URL): Promise<Response | FsError | undefined> {
    let result: Response | FsError | undefined
    if (!isExcluded(relativePath(url))) {
      result = await read(url, config.download)
      if (result instanceof Response) return result
    }
    for (const ext of config.extensions) {
      const candidate = new URL(url.href + encodeURIComponent(ext))
      if (isExcluded(relativePath(candidate))) continue
      const response = await read(candidate, config.download)
      if (response instanceof Response) return response
    }
    return result
  }

  ctx.server.get('{/*path}', async (req, res, next) => {
    const url = locate(req.params.path?.replace(/^\/+/, '') ?? '')
    let status: number, statusText: string
    if (!url) {
      status = 403
      statusText = 'Forbidden'
    } else if (url.pathname.endsWith('/')) {
      ;[status, statusText] = getStatus()
      for (const index of config.index) {
        const location = locate(index, url)
        const response = location && await tryFile(location)
        if (response instanceof Response) return response
      }
    } else {
      const result = await tryFile(url)
      if (result instanceof Response) return result
      ;[status, statusText] = getStatus(result)
      if (result?.code === 'IsADirectory' && config.redirect && !req.path.endsWith('/')) {
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
      const errorPage = await read(new URL(encodePath(errorPagePath), root))
      if (errorPage instanceof Response) {
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
