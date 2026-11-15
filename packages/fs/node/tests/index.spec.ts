import { Context, Fiber } from 'cordis'
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fs, { FsError } from '@cordisjs/fs'
import { conformance } from '@cordisjs/fs-conformance'
import NodeFs from '../src/index.ts'

const root = dirname(fileURLToPath(import.meta.url))

conformance('NodeFs', {
  async setup(ctx) {
    const fixture = resolve(root, '__conformance__')
    rmSync(fixture, { recursive: true, force: true })
    mkdirSync(fixture, { recursive: true })
    await ctx.use(NodeFs)
    return new URL(pathToFileURL(fixture).href + '/')
  },
  async teardown() {
    rmSync(resolve(root, '__conformance__'), { recursive: true, force: true })
  },
  capabilities: { symlink: true },
})

const fixture = resolve(root, '__file__')

function path(name: string) {
  return resolve(fixture, name)
}

function url(name: string) {
  return pathToFileURL(path(name))
}

async function rejects(promise: Promise<unknown>, code: FsError.Code) {
  const error = await promise.then(() => undefined, error => error)
  expect(error).to.be.instanceOf(FsError)
  expect(error.code).to.equal(code)
  return error as FsError
}

describe('NodeFs', () => {
  let fiber: Fiber | undefined
  let ctx: Context

  beforeEach(async () => {
    rmSync(fixture, { recursive: true, force: true })
    mkdirSync(fixture, { recursive: true })
    const root = new Context()
    fiber = await root.use(Fs)
    await root.use(NodeFs)
    ctx = root
  })

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
  })

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true })
  })

  describe('file', () => {
    // the descriptors of the process are listed in `/dev/fd`
    it.skipIf(process.platform === 'win32')('closes the file when a read is cancelled before the file is opened', async () => {
      writeFileSync(path('a.txt'), 'foo')
      const count = () => readdirSync('/dev/fd').length
      const before = count()
      await ctx.fs.file(url('a.txt')).stream().cancel()
      // an opening left behind by the cancellation would complete meanwhile
      await new Promise(r => setTimeout(r, 100))
      expect(count()).to.equal(before)
    })

    it('fails with the error of `node:fs` as the cause', async () => {
      const error = await rejects(ctx.fs.file(url('missing.txt')).text(), 'NotFound')
      expect(error.cause).to.be.instanceOf(Error)
    })
  })

  describe('access', () => {
    // the superuser may write to any file
    it.skipIf(process.getuid?.() === 0)('rejects a read-only file', async () => {
      writeFileSync(path('a.txt'), '')
      chmodSync(path('a.txt'), 0o444)
      try {
        await rejects(ctx.fs.access(url('a.txt'), 'write'), 'PermissionDenied')
      } finally {
        chmodSync(path('a.txt'), 0o644)
      }
    })
  })

  describe('stat', () => {
    it('reports the permission bits, the inode and the device', async () => {
      writeFileSync(path('a.txt'), '')
      const expected = statSync(path('a.txt'), { bigint: true })
      const stats = await ctx.fs.stat(url('a.txt'))
      expect(stats.mode).to.equal(Number(expected.mode & 0o7777n))
      expect(stats.ino).to.equal(expected.ino)
      expect(stats.dev).to.equal(expected.dev)
    })
  })

  describe('location', () => {
    // a host is valid in a Windows file URL, where it names a UNC path
    it.skipIf(process.platform === 'win32')('rejects a file URL with a host', async () => {
      writeFileSync(path('a.txt'), '')
      await rejects(ctx.fs.file('file://host/a.txt').text(), 'InvalidPath')
      await rejects(ctx.fs.rename(url('a.txt'), 'file://host/b.txt'), 'InvalidPath')
      expect(existsSync(path('a.txt'))).to.be.true
      expect(() => ctx.fs.watch('file://host/a.txt')).to.throw(FsError).with.property('code', 'InvalidPath')
    })
  })
})
