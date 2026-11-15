import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import * as http from 'node:http'
import Fs, { FsError } from '@cordisjs/fs'
import NodeFs from '@cordisjs/fs-node'
import Server from '@cordisjs/server'
import * as Static from '../src/index.ts'

function sleep(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')

async function setup(config: Partial<Static.Config> = {}, fsConfig: Fs.Config = {}) {
  const ctx = new Context()
  await ctx.use(Fs, fsConfig)
  await ctx.use(NodeFs)
  await ctx.use(Server, {
    host: '127.0.0.1',
    port: 0,
  })
  await ctx.use(Static, {
    root: pathToFileURL(fixturesDir).href + '/',
    ...config,
  } as Static.Config)
  return { ctx, url: ctx.server.publicUrl }
}

describe('@cordisjs/server-static', () => {
  let ctx: Context
  let url: string

  afterEach(async () => {
    await ctx?.fiber.dispose()
    await sleep()
  })

  describe('root', () => {
    it('should resolve a relative root against the base URL of fs', async () => {
      ({ ctx, url } = await setup({ root: 'fixtures' }, { baseUrl: new URL('.', import.meta.url).href }))
      const res = await fetch(`${url}/hello.html`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('<h1>Hello</h1>\n')
    })

    it('should take a root without a trailing slash as a directory', async () => {
      ({ ctx, url } = await setup({ root: pathToFileURL(fixturesDir).href }))
      const res = await fetch(`${url}/sub/`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal(readFileSync(resolve(fixturesDir, 'sub/index.html'), 'utf8'))
    })
  })

  describe('serving files', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should serve an existing file', async () => {
      const res = await fetch(`${url}/hello.html`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('<h1>Hello</h1>\n')
    })


    it('should return 404 for missing file', async () => {
      const res = await fetch(`${url}/nonexistent.html`)
      expect(res.status).to.equal(404)
    })

    it('should serve file without extension', async () => {
      const res = await fetch(`${url}/noext`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('plain text\n')
    })
  })

  describe('extension fallback', () => {
    it('should not try extensions by default', async () => {
      ({ ctx, url } = await setup())
      const res = await fetch(`${url}/hello`)
      expect(res.status).to.equal(404)
    })

    it('should try .html extension when configured', async () => {
      ({ ctx, url } = await setup({ extensions: ['.html'] }))
      const res = await fetch(`${url}/hello`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('<h1>Hello</h1>\n')
    })

    it('should prefer exact file over extension fallback', async () => {
      ({ ctx, url } = await setup({ extensions: ['.html'] }))
      const res = await fetch(`${url}/page`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('<h1>Page without extension</h1>\n')
    })
  })

  describe('index files', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should serve index file for root', async () => {
      const res = await fetch(`${url}/`, { redirect: 'manual' })
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('<h1>Index</h1>\n')
    })

    it('should serve index file for subdirectory with trailing slash', async () => {
      const res = await fetch(`${url}/sub/`, { redirect: 'manual' })
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('<h1>Sub Index</h1>\n')
    })
  })

  describe('directory redirect', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should redirect directory without trailing slash', async () => {
      const res = await fetch(`${url}/sub`, { redirect: 'manual' })
      expect(res.status).to.equal(301)
      expect(res.headers.get('location')).to.include('/sub/')
    })

    it('should not redirect when redirect is disabled', async () => {
      ({ ctx, url } = await setup({ redirect: false }))
      const res = await fetch(`${url}/sub`, { redirect: 'manual' })
      expect(res.status).to.not.equal(301)
    })
  })

  describe('path traversal protection', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should return 403 for path traversal', async () => {
      // fetch() normalizes URLs, so we use raw http.get to preserve ..
      const port = ctx.server.port
      const res = await new Promise<http.IncomingMessage>((resolve) => {
        http.get({ host: '127.0.0.1', port, path: '/..%2F..%2F..%2Fetc/passwd' }, resolve)
      })
      expect(res.statusCode).to.equal(403)
    })
  })

  describe('fallthrough', () => {
    it('should not fallthrough by default', async () => {
      ({ ctx, url } = await setup())
      const res = await fetch(`${url}/missing`)
      expect(res.status).to.equal(404)
    })

    it('should fallthrough when enabled', async () => {
      ({ ctx, url } = await setup({ fallthrough: true }))
      ctx.server.get('{/*path}', async (req, res, next) => {
        res.body = 'fallback'
      })
      await sleep()

      const res = await fetch(`${url}/missing`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('fallback')
    })
  })

  describe('error pages', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup({ errorPages: { 404: 'errors/404.html' } }))
    })

    it('should serve custom error page with original status', async () => {
      const res = await fetch(`${url}/nonexistent`)
      expect(res.status).to.equal(404)
      expect(await res.text()).to.equal('<h1>Not Found</h1>\n')
    })

    it('should display the error page regardless of disposition', async () => {
      ({ ctx, url } = await setup({ disposition: 'attachment', errorPages: { 404: 'errors/404.html' } }))
      const res = await fetch(`${url}/nonexistent`)
      expect(res.status).to.equal(404)
      expect(res.headers.get('content-disposition')).to.equal(null)
    })
  })

  describe('exclude', () => {
    it('should block files matching exclude pattern', async () => {
      ({ ctx, url } = await setup({ exclude: ['**/.*'] }))
      const res = await fetch(`${url}/.secret`)
      expect(res.status).to.equal(404)
    })

    it('should serve files not matching exclude pattern', async () => {
      ({ ctx, url } = await setup({ exclude: ['**/.*'] }))
      const res = await fetch(`${url}/hello.html`)
      expect(res.status).to.equal(200)
    })

    it('should support multiple exclude patterns', async () => {
      ({ ctx, url } = await setup({ exclude: ['*.html', 'noext'] }))
      const res1 = await fetch(`${url}/hello.html`)
      expect(res1.status).to.equal(404)
      const res2 = await fetch(`${url}/noext`)
      expect(res2.status).to.equal(404)
    })

    it('should match exclude patterns against paths separated by slashes', async () => {
      ({ ctx, url } = await setup({ exclude: ['sub/**'] }))
      const res1 = await fetch(`${url}/sub/index.html`)
      expect(res1.status).to.equal(404)
      const res2 = await fetch(`${url}/hello.html`)
      expect(res2.status).to.equal(200)
    })
  })

  describe('disposition', () => {
    it('should set an attachment disposition', async () => {
      ({ ctx, url } = await setup({ disposition: 'attachment' }))
      const res = await fetch(`${url}/hello.html`)
      expect(res.status).to.equal(200)
      const disposition = res.headers.get('content-disposition')
      expect(disposition).to.include('attachment')
    })

    it('should set an inline disposition', async () => {
      ({ ctx, url } = await setup({ disposition: 'inline' }))
      const res = await fetch(`${url}/hello.html`)
      expect(res.status).to.equal(200)
      const disposition = res.headers.get('content-disposition')
      expect(disposition).to.include('inline')
    })
  })

  describe('content type', () => {
    // a 1x1 PNG image
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

    // a ZIP archive with one stored entry of `size` bytes
    function zip(name: string, size: number) {
      const filename = Buffer.from(name)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(10, 4)
      local.writeUInt32LE(size, 18)
      local.writeUInt32LE(size, 22)
      local.writeUInt16LE(filename.length, 26)
      const central = Buffer.alloc(46)
      central.writeUInt32LE(0x02014b50, 0)
      central.writeUInt16LE(10, 4)
      central.writeUInt16LE(10, 6)
      central.writeUInt32LE(size, 20)
      central.writeUInt32LE(size, 24)
      central.writeUInt16LE(filename.length, 28)
      const end = Buffer.alloc(22)
      end.writeUInt32LE(0x06054b50, 0)
      end.writeUInt16LE(1, 8)
      end.writeUInt16LE(1, 10)
      end.writeUInt32LE(central.length + filename.length, 12)
      end.writeUInt32LE(local.length + filename.length + size, 16)
      return Buffer.concat([local, filename, Buffer.alloc(size), central, filename, end])
    }

    // the number of streams that are neither closed, errored nor cancelled
    let active = 0

    // serves `files` under `memory:/` in chunks of `chunkSize` bytes
    async function setupMemory(files: Record<string, Uint8Array>, chunkSize: number) {
      ;({ ctx, url } = await setup({ root: 'memory:/' }))
      active = 0
      ctx.fs.mount('memory:', {
        read(location) {
          const content = files[location.pathname.slice(1)]
          let offset = 0
          active++
          return new ReadableStream({
            pull(controller) {
              if (!content) {
                active--
                return controller.error(new FsError('NotFound', location, `no file at ${location.href}`))
              }
              if (offset >= content.length) {
                active--
                return controller.close()
              }
              controller.enqueue(content.subarray(offset, offset += chunkSize))
            },
            cancel() {
              active--
            },
          })
        },
      })
    }

    it('should detect the type of content split into small chunks', async () => {
      await setupMemory({ image: png }, 8)
      const res = await fetch(`${url}/image`)
      expect(res.status).to.equal(200)
      expect(res.headers.get('content-type')).to.equal('image/png')
      expect(Buffer.from(await res.arrayBuffer())).to.deep.equal(png)
      expect(active).to.equal(0)
    })

    it('should detect the type of content beyond the first chunk', async () => {
      const archive = zip('data.bin', 192 * 1024)
      await setupMemory({ archive }, 64 * 1024)
      const res = await fetch(`${url}/archive`)
      expect(res.status).to.equal(200)
      expect(res.headers.get('content-type')).to.equal('application/zip')
      expect((await res.arrayBuffer()).byteLength).to.equal(archive.length)
      expect(active).to.equal(0)
    })
  })
})
