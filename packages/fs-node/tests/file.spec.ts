import { Context, Fiber } from 'cordis'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fs, { FsError, FsErrorCode } from '../src/index.ts'

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '__file__')

function path(name: string) {
  return resolve(fixture, name)
}

async function rejects(promise: Promise<unknown>, code: FsErrorCode) {
  const error = await promise.then(() => undefined, error => error)
  expect(error).to.be.instanceOf(FsError)
  expect(error.code).to.equal(code)
  return error as FsError
}

describe('Fs', () => {
  let fiber: Fiber<Context> | undefined
  let ctx: Context

  beforeEach(async () => {
    rmSync(fixture, { recursive: true, force: true })
    mkdirSync(fixture, { recursive: true })
    const root = new Context()
    fiber = await root.plugin(Fs)
    await root.inject(['fs'], (inner) => { ctx = inner })
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
      const file = ctx.fs.file(path('missing/missing.txt'))
      expect(file.url.href).to.equal(pathToFileURL(path('missing/missing.txt')).href)
    })

    it('reads the current content', async () => {
      const file = ctx.fs.file(path('a.txt'))
      writeFileSync(path('a.txt'), 'foo')
      expect(await file.text()).to.equal('foo')
      writeFileSync(path('a.txt'), 'bar')
      expect(await file.text()).to.equal('bar')
    })

    it('writes a file, creating it if it is missing', async () => {
      await ctx.fs.file(path('a.txt')).write('foo')
      expect(readFileSync(path('a.txt'), 'utf8')).to.equal('foo')
      await ctx.fs.file(path('a.txt')).write('bar')
      expect(readFileSync(path('a.txt'), 'utf8')).to.equal('bar')
    })

    it('does not create the parent directory', async () => {
      await rejects(ctx.fs.file(path('missing/a.txt')).write('foo'), 'NotFound')
      expect(existsSync(path('missing'))).to.be.false
    })

    it('fails to read a missing file with the location', async () => {
      const file = ctx.fs.file(path('missing.txt'))
      const error = await rejects(file.text(), 'NotFound')
      expect(error.url?.href).to.equal(file.url.href)
      expect(error.cause).to.be.instanceOf(Error)
    })

    it('fails to read a directory', async () => {
      mkdirSync(path('dir'))
      await rejects(ctx.fs.file(path('dir')).text(), 'IsADirectory')
    })
  })

  describe('access', () => {
    it('resolves for a writable file', async () => {
      writeFileSync(path('a.txt'), '')
      await ctx.fs.access(path('a.txt'), 'write')
    })

    // the superuser may write to any file
    it.skipIf(process.getuid?.() === 0)('rejects a read-only file', async () => {
      writeFileSync(path('a.txt'), '')
      chmodSync(path('a.txt'), 0o444)
      try {
        await rejects(ctx.fs.access(path('a.txt'), 'write'), 'PermissionDenied')
      } finally {
        chmodSync(path('a.txt'), 0o644)
      }
    })

    it('rejects a missing file', async () => {
      await rejects(ctx.fs.access(path('missing.txt'), 'write'), 'NotFound')
    })
  })

  describe('rename', () => {
    it('replaces an existing file', async () => {
      writeFileSync(path('a.txt'), 'foo')
      writeFileSync(path('b.txt'), 'bar')
      await ctx.fs.rename(path('a.txt'), path('b.txt'))
      expect(existsSync(path('a.txt'))).to.be.false
      expect(readFileSync(path('b.txt'), 'utf8')).to.equal('foo')
    })

    // Windows reports a directory as the target of a rename as `EPERM`, which
    // is classified as `Busy` without further I/O
    it.skipIf(process.platform === 'win32')('fails on a non-empty directory', async () => {
      mkdirSync(path('a'))
      mkdirSync(path('b'))
      writeFileSync(path('b/c.txt'), '')
      await rejects(ctx.fs.rename(path('a'), path('b')), 'DirectoryNotEmpty')
    })

    it('fails on a missing source', async () => {
      await rejects(ctx.fs.rename(path('missing.txt'), path('b.txt')), 'NotFound')
    })
  })

  describe('remove', () => {
    it('removes a file', async () => {
      writeFileSync(path('a.txt'), '')
      await ctx.fs.remove(path('a.txt'))
      expect(existsSync(path('a.txt'))).to.be.false
    })

    it('removes an empty directory', async () => {
      mkdirSync(path('dir'))
      await ctx.fs.remove(path('dir'))
      expect(existsSync(path('dir'))).to.be.false
    })

    it('fails on a non-empty directory', async () => {
      mkdirSync(path('dir'))
      writeFileSync(path('dir/a.txt'), '')
      await rejects(ctx.fs.remove(path('dir')), 'DirectoryNotEmpty')
      expect(existsSync(path('dir/a.txt'))).to.be.true
    })

    it('removes a link without its target', async () => {
      mkdirSync(path('dir'))
      writeFileSync(path('dir/a.txt'), '')
      symlinkSync(path('dir'), path('link'), 'junction')
      await ctx.fs.remove(path('link'))
      expect(existsSync(path('link'))).to.be.false
      expect(existsSync(path('dir/a.txt'))).to.be.true
    })

    it('fails on a missing location unless forced', async () => {
      await rejects(ctx.fs.remove(path('missing.txt')), 'NotFound')
      await ctx.fs.remove(path('missing.txt'), { force: true })
    })
  })

  describe('location', () => {
    it('rejects a file URL with a query or a fragment', () => {
      for (const input of [`${pathToFileURL(path('a.txt'))}?x`, `${pathToFileURL(path('a.txt'))}#x`]) {
        expect(() => ctx.fs.file(input), input).to.throw(FsError, /^InvalidPath:/)
      }
    })

    it('rejects a path with a NUL character', () => {
      expect(() => ctx.fs.file(path('a\0b.txt'))).to.throw(FsError, /^InvalidPath:/)
      expect(() => ctx.fs.file(`${pathToFileURL(fixture)}/a%00b.txt`)).to.throw(FsError, /^InvalidPath:/)
    })

    it('rejects a URL of another scheme', () => {
      expect(() => ctx.fs.file(new URL('s3://bucket/a.txt'))).to.throw(FsError, /^NotSupported:/)
    })

    it('rejects an invalid location in an asynchronous method', async () => {
      await rejects(ctx.fs.remove(path('a\0b.txt')), 'InvalidPath')
    })
  })
})
