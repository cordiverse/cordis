import { Context, Fiber } from 'cordis'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
  windows: process.platform === 'win32',
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

    // permission bits do not exist on Windows
    it.skipIf(process.platform === 'win32')('gives a new or an existing file the permission bits of `mode`', async () => {
      writeFileSync(path('b.sh'), '')
      chmodSync(path('b.sh'), 0o600)
      await ctx.fs.file(url('a.sh')).write('foo', { mode: 0o751 })
      await ctx.fs.file(url('b.sh')).write('bar', { mode: 0o751 })
      expect([statSync(path('a.sh')).mode & 0o7777, statSync(path('b.sh')).mode & 0o7777]).to.deep.equal([0o751, 0o751])
      expect(readFileSync(path('b.sh'), 'utf8')).to.equal('bar')
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

  describe('copy', () => {
    // `b/` is a second mount of the same disk, to which a copy is a read and a write
    async function mountB() {
      mkdirSync(path('b'))
      await ctx.use(NodeFs, { mount: pathToFileURL(path('b')).href + '/' })
    }

    it('creates the file once for two concurrent copies with `overwrite: false`', async () => {
      writeFileSync(path('a.txt'), 'foo')
      writeFileSync(path('b.txt'), 'bar')
      const results = await Promise.allSettled([
        ctx.fs.copy(url('a.txt'), url('c.txt'), { overwrite: false }),
        ctx.fs.copy(url('b.txt'), url('c.txt'), { overwrite: false }),
      ])
      const created = results.findIndex(result => result.status === 'fulfilled')
      expect(results.filter(result => result.status === 'fulfilled')).to.have.length(1)
      expect((results[1 - created] as PromiseRejectedResult).reason).to.have.property('code', 'AlreadyExists')
      expect(await ctx.fs.file(url('c.txt')).text()).to.equal(['foo', 'bar'][created])
    })

    // links require a privilege on Windows
    it.skipIf(process.platform === 'win32')('resolves a dangling link at the destination as the file system does, with `overwrite: false`', async () => {
      writeFileSync(path('a.txt'), 'foo')
      mkdirSync(path('real/deep'), { recursive: true })
      symlinkSync('real/deep', path('shortcut'))
      // `..` follows the link `shortcut`, and a trailing separator names a directory
      symlinkSync('shortcut/../created.txt', path('link'))
      symlinkSync('missing/', path('slash'))
      await ctx.fs.copy(url('a.txt'), url('link'), { overwrite: false })
      expect(readFileSync(path('real/created.txt'), 'utf8')).to.equal('foo')
      expect(existsSync(path('created.txt'))).to.be.false
      expect(await ctx.fs.copy(url('a.txt'), url('slash'), { overwrite: false }).catch(error => error)).to.be.instanceOf(FsError)
      expect(existsSync(path('missing'))).to.be.false
    })

    // as above
    it.skipIf(process.platform === 'win32')('fails on a loop of links at the destination with the error of the loop', async () => {
      writeFileSync(path('a.txt'), 'foo')
      symlinkSync('loop', path('loop'))
      for (const overwrite of [true, false]) {
        const error = await ctx.fs.copy(url('a.txt'), url('loop'), { overwrite }).catch(error => error)
        expect(error).to.be.instanceOf(FsError)
        expect(error.cause).to.have.property('code', 'ELOOP')
      }
    })

    // permission bits do not exist on Windows
    it.skipIf(process.platform === 'win32')('gives the destination the permission bits of the source, also from another mount', async () => {
      await mountB()
      writeFileSync(path('a.sh'), 'foo')
      chmodSync(path('a.sh'), 0o751)
      writeFileSync(path('private.txt'), 'bar')
      chmodSync(path('private.txt'), 0o600)
      for (const dest of ['dest.sh', 'b/dest.sh']) {
        writeFileSync(path(dest), '')
        chmodSync(path(dest), 0o600)
      }
      const mode = (name: string) => statSync(path(name)).mode & 0o7777
      await ctx.fs.copy(url('a.sh'), url('dest.sh'))
      await ctx.fs.copy(url('a.sh'), url('b/dest.sh'))
      await ctx.fs.copy(url('private.txt'), url('b/private.txt'))
      expect([mode('dest.sh'), mode('b/dest.sh'), mode('b/private.txt')]).to.deep.equal([0o751, 0o751, 0o600])
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
