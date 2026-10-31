import { createHash } from 'node:crypto'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'

export interface PackageVersion {
  name: string
  version: string
  dependencies?: Record<string, string>
}

function header(name: string, size: number) {
  const buffer = Buffer.alloc(512)
  buffer.write(name, 0, 100)
  buffer.write('0000644\0', 100)
  buffer.write('0000000\0', 108)
  buffer.write('0000000\0', 116)
  buffer.write(size.toString(8).padStart(11, '0') + '\0', 124)
  buffer.write('00000000000\0', 136)
  buffer.write('        ', 148)
  buffer.write('0', 156)
  buffer.write('ustar\0', 257)
  buffer.write('00', 263)
  let sum = 0
  for (const byte of buffer) sum += byte
  buffer.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return buffer
}

/** A gzipped tarball with the files under `package/`. */
export function pack(files: Record<string, string>) {
  const chunks: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    chunks.push(header(`package/${name}`, data.length), data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

/** An npm registry serving the given versions over HTTP on 127.0.0.1. */
export class Registry {
  server: Server
  url!: string
  tarballs = new Map<string, Buffer>()
  packuments = new Map<string, any>()
  /** a tarball request for which this returns a promise is answered when it settles */
  delay?: (path: string) => Promise<void> | undefined
  /** packages whose tarballs are answered with 404 */
  unavailable = new Set<string>()

  constructor(private versions: PackageVersion[]) {
    this.server = createServer(async (req, res) => {
      const path = decodeURIComponent(req.url!.split('?')[0]).slice(1)
      const tarball = this.tarballs.get(path)
      if (tarball && this.unavailable.has(path.split('/-/')[0])) {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end('{"error":"not found"}')
      }
      if (tarball) {
        await this.delay?.(path)
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        return res.end(tarball)
      }
      const packument = this.packuments.get(path)
      if (!packument) {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end('{"error":"not found"}')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(packument))
    })
  }

  async start() {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`
    for (const meta of this.versions) {
      const manifest = { ...meta, main: 'index.js' }
      const tarball = pack({
        'package.json': JSON.stringify(manifest, null, 2),
        'index.js': `module.exports = ${JSON.stringify(`${meta.name}@${meta.version}`)}\n`,
      })
      const path = `${meta.name}/-/${meta.name.split('/').pop()}-${meta.version}.tgz`
      this.tarballs.set(path, tarball)
      const packument = this.packuments.get(meta.name) ?? {
        'name': meta.name,
        'dist-tags': {},
        'versions': {},
        'time': { created: '2020-01-01T00:00:00.000Z', modified: '2020-01-01T00:00:00.000Z' },
      }
      packument.versions[meta.version] = {
        ...manifest,
        dist: {
          tarball: this.url + path,
          shasum: createHash('sha1').update(tarball).digest('hex'),
          integrity: 'sha512-' + createHash('sha512').update(tarball).digest('base64'),
        },
      }
      packument.time[meta.version] = '2020-01-01T00:00:00.000Z'
      packument['dist-tags'].latest = meta.version
      this.packuments.set(meta.name, packument)
    }
  }

  stop() {
    this.server.closeAllConnections()
    return new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}
