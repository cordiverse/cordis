import { Context, Fiber } from 'cordis'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fs, { FsError } from '@cordisjs/fs'
import NodeFs from '../src/index.ts'

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '__file__')

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
    it('performs no I/O when the reference is created', () => {
      const file = ctx.fs.file(url('missing/missing.txt'))
      expect(file.url.href).to.equal(pathToFileURL(path('missing/missing.txt')).href)
    })

    it('reads the current content', async () => {
      const file = ctx.fs.file(url('a.txt'))
      writeFileSync(path('a.txt'), 'foo')
      expect(await file.text()).to.equal('foo')
      writeFileSync(path('a.txt'), 'bar')
      expect(await file.text()).to.equal('bar')
    })

    it('writes a file, creating it if it is missing', async () => {
      await ctx.fs.file(url('a.txt')).write('foo')
      expect(readFileSync(path('a.txt'), 'utf8')).to.equal('foo')
      await ctx.fs.file(url('a.txt')).write('bar')
      expect(readFileSync(path('a.txt'), 'utf8')).to.equal('bar')
    })

    it('streams a content larger than a chunk', async () => {
      const content = new Uint8Array(200 * 1024).map((_, index) => index % 251)
      writeFileSync(path('a.bin'), content)
      expect(await ctx.fs.file(url('a.bin')).bytes()).to.deep.equal(content)

      await ctx.fs.file(url('b.bin')).write(ctx.fs.file(url('a.bin')).stream())
      expect(new Uint8Array(readFileSync(path('b.bin')))).to.deep.equal(content)
    })

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

    it('fails to read or write a location named with a trailing separator', async () => {
      mkdirSync(path('dir'))
      await rejects(ctx.fs.file(`${url('dir')}/`).text(), 'IsADirectory')
      await rejects(ctx.fs.file(`${url('missing')}/`).write('foo'), 'IsADirectory')
      expect(existsSync(path('missing'))).to.be.false
    })

    it('rejects a write with the error of the stream', async () => {
      const error = new Error('aborted')
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('foo'))
          controller.error(error)
        },
      })
      expect(await ctx.fs.file(url('a.txt')).write(body).catch(error => error)).to.equal(error)
    })

        it('does not create the parent directory', async () => {
      await rejects(ctx.fs.file(url('missing/a.txt')).write('foo'), 'NotFound')
      expect(existsSync(path('missing'))).to.be.false
    })

    it('fails to read a missing file with the location', async () => {
      const file = ctx.fs.file(url('missing.txt'))
      const error = await rejects(file.text(), 'NotFound')
      expect(error.url?.href).to.equal(file.url.href)
      expect(error.cause).to.be.instanceOf(Error)
    })

    it('fails to read a directory', async () => {
      mkdirSync(path('dir'))
      await rejects(ctx.fs.file(url('dir')).text(), 'IsADirectory')
    })
  })

  describe('access', () => {
    it('resolves for a writable file', async () => {
      writeFileSync(path('a.txt'), '')
      await ctx.fs.access(url('a.txt'), 'write')
    })

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

    it('rejects a missing file', async () => {
      await rejects(ctx.fs.access(url('missing.txt'), 'write'), 'NotFound')
    })
  })

  describe('rename', () => {
    it('replaces an existing file', async () => {
      writeFileSync(path('a.txt'), 'foo')
      writeFileSync(path('b.txt'), 'bar')
      await ctx.fs.rename(url('a.txt'), url('b.txt'))
      expect(existsSync(path('a.txt'))).to.be.false
      expect(readFileSync(path('b.txt'), 'utf8')).to.equal('foo')
    })

    // Windows reports a directory as the target of a rename as `EPERM`, which
    // is classified as `Busy` without further I/O
    it.skipIf(process.platform === 'win32')('fails on a non-empty directory', async () => {
      mkdirSync(path('a'))
      mkdirSync(path('b'))
      writeFileSync(path('b/c.txt'), '')
      await rejects(ctx.fs.rename(url('a'), url('b')), 'DirectoryNotEmpty')
    })

    it('renames a link named with a trailing separator without its target', async () => {
      mkdirSync(path('dir'))
      symlinkSync(path('dir'), path('link'), 'junction')
      await ctx.fs.rename(`${url('link')}/`, url('moved'))
      expect(lstatSync(path('moved')).isSymbolicLink()).to.be.true
      expect(existsSync(path('link'))).to.be.false
      expect(existsSync(path('dir'))).to.be.true
    })

    it('does not replace the target of a link named with a trailing separator', async () => {
      mkdirSync(path('src'))
      writeFileSync(path('src/a.txt'), '')
      mkdirSync(path('dir'))
      symlinkSync(path('dir'), path('link'), 'junction')
      // the link may be replaced, or the rename may fail
      await ctx.fs.rename(url('src'), `${url('link')}/`).catch(() => {})
      expect(existsSync(path('dir/a.txt'))).to.be.false
    })

    it('requires a directory for a trailing separator of the destination', async () => {
      writeFileSync(path('a.txt'), 'foo')
      await rejects(ctx.fs.rename(url('a.txt'), `${url('b')}/`), 'NotADirectory')
      expect(readFileSync(path('a.txt'), 'utf8')).to.equal('foo')

      mkdirSync(path('src'))
      await ctx.fs.rename(url('src'), `${url('b')}/`)
      expect(lstatSync(path('b')).isDirectory()).to.be.true
    })

    it('fails on a missing source', async () => {
      await rejects(ctx.fs.rename(url('missing.txt'), url('b.txt')), 'NotFound')
    })
  })

  describe('remove', () => {
    it('removes a file', async () => {
      writeFileSync(path('a.txt'), '')
      await ctx.fs.remove(url('a.txt'))
      expect(existsSync(path('a.txt'))).to.be.false
    })

    it('removes an empty directory', async () => {
      mkdirSync(path('dir'))
      await ctx.fs.remove(url('dir'))
      expect(existsSync(path('dir'))).to.be.false
    })

    it('fails on a non-empty directory', async () => {
      mkdirSync(path('dir'))
      writeFileSync(path('dir/a.txt'), '')
      await rejects(ctx.fs.remove(url('dir')), 'DirectoryNotEmpty')
      expect(existsSync(path('dir/a.txt'))).to.be.true
    })

    it('removes a link without its target', async () => {
      mkdirSync(path('dir'))
      writeFileSync(path('dir/a.txt'), '')
      symlinkSync(path('dir'), path('link'), 'junction')
      await ctx.fs.remove(url('link'))
      expect(existsSync(path('link'))).to.be.false
      expect(existsSync(path('dir/a.txt'))).to.be.true
    })

    it('removes a link named with a trailing separator without its target', async () => {
      mkdirSync(path('dir'))
      symlinkSync(path('dir'), path('link'), 'junction')
      await ctx.fs.remove(`${url('link')}/`)
      expect(existsSync(path('link'))).to.be.false
      expect(existsSync(path('dir'))).to.be.true
    })

    // creating a link to a file requires a privilege on Windows
    it.skipIf(process.platform === 'win32')('keeps a link to a file named with a trailing separator', async () => {
      writeFileSync(path('a.txt'), '')
      symlinkSync(path('a.txt'), path('link'))
      await rejects(ctx.fs.remove(`${url('link')}/`), 'NotADirectory')
      expect(lstatSync(path('link')).isSymbolicLink()).to.be.true
      expect(existsSync(path('a.txt'))).to.be.true
    })

    it('fails on a missing location unless forced', async () => {
      await rejects(ctx.fs.remove(url('missing.txt')), 'NotFound')
      await ctx.fs.remove(url('missing.txt'), { force: true })
    })
  })

  describe('location', () => {
    it('does not apply an operation on a directory location to a file', async () => {
      writeFileSync(path('a.txt'), 'foo')
      const dir = `${url('a.txt')}/`
      await rejects(ctx.fs.file(dir).text(), 'IsADirectory')
      await rejects(ctx.fs.file(dir).write('bar'), 'IsADirectory')
      // each operation is started after the previous one has settled
      for (const operation of [
        () => ctx.fs.access(dir, 'write'),
        () => ctx.fs.rename(dir, url('b.txt')),
        () => ctx.fs.remove(dir),
      ]) {
        await rejects(operation(), 'NotADirectory')
      }
      expect(readFileSync(path('a.txt'), 'utf8')).to.equal('foo')
    })

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
