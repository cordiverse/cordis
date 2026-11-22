import { Context, Fiber } from 'cordis'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync,
  readFileSync, readSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  capabilities: { symlink: true, exclusive: true, atomic: true },
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

  describe('atomic write', () => {
    it('atomically replaces a file whose name fills the filesystem component limit', async () => {
      const name = 'a'.repeat(255)
      writeFileSync(path(name), 'old')
      await ctx.fs.file(url(name)).write('new', { atomic: true })
      expect(readFileSync(path(name), 'utf8')).to.equal('new')
    })

    it('preserves a destination created while opening a cross-mount exclusive copy', async () => {
      ctx.fs.mount('src:', {
        async stat() { return { type: 'file', size: 4, mtime: new Date(0) } },
        read() {
          writeFileSync(path('dest'), 'concurrent')
          return new Blob(['copy']).stream()
        },
      })
      await rejects(ctx.fs.copy('src:///file', url('dest'), { exclusive: true }), 'AlreadyExists')
      expect(readFileSync(path('dest'), 'utf8')).to.equal('concurrent')
    })

    it('removes the temporary file of a failed write while another branch of a tee is open', async () => {
      const handle = await open(path('dest'), 'w')
      await handle.writeFile('old')
      await handle.close()
      const failure = new Error('disk write failed')
      const write = vi.spyOn(Object.getPrototypeOf(handle), 'write').mockRejectedValueOnce(failure)
      const [stream, sibling] = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1])) },
      }).tee()
      try {
        await expect(ctx.fs.file(url('dest')).write(stream, { atomic: true })).rejects.toBe(failure)
        expect(readFileSync(path('dest'), 'utf8')).to.equal('old')
        expect(readdirSync(fixture)).to.deep.equal(['dest'])
      } finally {
        write.mockRestore()
        await sibling.cancel()
      }
    })

    it('keeps the destination when a cross-mount atomic copy fails mid-stream', async () => {
      writeFileSync(path('dest'), 'old')
      const failure = new Error('source failed')
      ctx.fs.mount('src:', {
        async stat() { return { type: 'file', size: 2, mtime: new Date(0) } },
        read() {
          return new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array([1])) },
            pull(controller) { controller.error(failure) },
          }, { highWaterMark: 0 })
        },
      })
      await expect(ctx.fs.copy('src:///file', url('dest'), { atomic: true })).rejects.toBe(failure)
      expect(readFileSync(path('dest'), 'utf8')).to.equal('old')
      expect(readdirSync(fixture)).to.deep.equal(['dest'])
    })

    it('removes the temporary file when the stream reports `AlreadyExists`', async () => {
      writeFileSync(path('dest'), 'old')
      const failure = new FsError('AlreadyExists', url('source'), 'source failed')
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure) } })
      await expect(ctx.fs.file(url('dest')).write(body, { atomic: true })).rejects.toBe(failure)
      expect(readdirSync(fixture)).to.deep.equal(['dest'])
      expect(readFileSync(path('dest'), 'utf8')).to.equal('old')
    })

    it.skipIf(process.platform === 'win32')('keeps a file that replaces the one an exclusive write created while it reads its source', async () => {
      const file = ctx.fs.file(url('dest'))
      const failure = new Error('source failed')
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await file.write('replacement', { atomic: true })
          controller.error(failure)
        },
      }, { highWaterMark: 0 })
      await expect(file.write(body, { exclusive: true })).rejects.toBe(failure)
      expect(await file.text()).to.equal('replacement')
    })

    it('fails with `NotSupported` on `atomic` with `exclusive` before writing or copying', async () => {
      const dest = ctx.fs.file(url('dest'))
      const options = { atomic: true, exclusive: true }
      writeFileSync(path('src'), 'source')
      const cancel = vi.fn()
      await rejects(dest.write(new ReadableStream({ cancel }), options), 'NotSupported')
      expect(cancel).toHaveBeenCalledOnce()
      await rejects(ctx.fs.copy(url('src'), dest.url, options), 'NotSupported')
      expect(readdirSync(fixture)).to.deep.equal(['src'])
    })

    it.skipIf(process.platform === 'win32')('writes and copies atomically after the name of a temporary file collides with a dangling link', async () => {
      writeFileSync(path('src'), 'source')
      writeFileSync(path('dest'), 'old')
      symlinkSync('foreign', path('.cordis-000000000000.tmp'))
      const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation(bytes => bytes)
      try {
        await ctx.fs.file(url('dest')).write('new', { atomic: true })
        expect(readFileSync(path('dest'), 'utf8')).to.equal('new')
        await ctx.fs.copy(url('src'), url('dest'), { atomic: true })
        expect(readFileSync(path('dest'), 'utf8')).to.equal('source')
        expect(await ctx.fs.readlink(url('.cordis-000000000000.tmp'))).to.equal('foreign')
        expect(existsSync(path('foreign'))).to.equal(false)
      } finally {
        random.mockRestore()
      }
    })

    // POSIX resolves `..` after the preceding link, and Windows before it
    it('writes through a link whose target traverses another link before ".." as the system does', async () => {
      mkdirSync(path('real/deep'), { recursive: true })
      symlinkSync(['real', 'deep'].join(sep), path('shortcut'), 'dir')
      // the target as stored, which `join()` would normalize to `target`
      const target = ['shortcut', '..', 'target'].join(sep)
      symlinkSync(target, path('link'), 'file')
      // the location that a write of `node:fs` through the link creates
      writeFileSync(path('link'), 'native')
      const native = [path('real/target'), path('target')].filter(file => existsSync(file))
      expect(native).to.have.length(1)
      rmSync(native[0])
      for (const options of [{ atomic: true }, { exclusive: true }]) {
        await ctx.fs.file(url('link')).write('data', options)
        expect(readFileSync(native[0], 'utf8')).to.equal('data')
        rmSync(native[0])
      }
      expect(await ctx.fs.readlink(url('link'))).to.equal(target)
    })

    it('keeps the limit of links of the system on an existing target', async () => {
      writeFileSync(path('file'), 'old')
      symlinkSync('file', path('link0'), 'file')
      for (let i = 1; i <= 64; i++) symlinkSync('link' + (i - 1), path('link' + i), 'file')
      // the shortest chain that the system rejects, if any within 64 links
      const native = Array.from({ length: 65 }, (_, i) => i).find((i) => {
        try {
          readFileSync(path('link' + i))
          return false
        } catch {
          return true
        }
      })
      for (const i of native === undefined ? [] : [native, 64]) {
        await rejects(ctx.fs.file(url('link' + i)).write('new', { atomic: true }), 'InvalidPath')
        expect(readFileSync(path('file'), 'utf8')).to.equal('old')
      }
    })

    it('requires a directory for a trailing separator of the location it resolves', async () => {
      writeFileSync(path('file'), '')
      const provider = new NodeFs(ctx, { mount: url('.').href + '/' })
      await rejects(provider.realpath(new URL(url('file').href + '/')), 'NotADirectory')
      expect((await provider.realpath(new URL(url('missing').href + '/'))).href).to.match(/\/missing\/$/)
    })

    it.skipIf(process.platform === 'win32')('fails with `InvalidPath` on a link target that is not valid UTF-8', async () => {
      const lookalike = 'a\uFFFDb'
      writeFileSync(path(lookalike), 'old')
      symlinkSync(Buffer.from([0x61, 0xFF, 0x62]), path('link'))
      await rejects(ctx.fs.readlink(url('link')), 'InvalidPath')
      for (const options of [{ atomic: true }, { exclusive: true }]) {
        await rejects(ctx.fs.file(url('link')).write('new', options), 'InvalidPath')
      }
      expect(readFileSync(path(lookalike), 'utf8')).to.equal('old')
    })

    it('requires a directory for a link target with a trailing separator, as the system does', async () => {
      writeFileSync(path('ordinary'), 'old')
      symlinkSync('ordinary' + sep, path('link'), 'file')
      const native = await writeFile(path('link'), 'native').then(() => true, () => false)
      writeFileSync(path('ordinary'), 'old')
      expect(await ctx.fs.file(url('link')).write('data', { atomic: true }).then(() => true, () => false)).to.equal(native)
      if (!native) {
        await expect(ctx.fs.file(url('link')).write('data', { exclusive: true })).rejects.toBeInstanceOf(FsError)
        expect(readFileSync(path('ordinary'), 'utf8')).to.equal('old')
      }
    })

    it.skipIf(process.platform === 'win32')('keeps a backslash in a POSIX link target as a part of a name', async () => {
      symlinkSync('new\\name', path('link'))
      await ctx.fs.file(url('link')).write('data', { exclusive: true })
      expect(readFileSync(path('new\\name'), 'utf8')).to.equal('data')
    })

    it.skipIf(process.platform === 'win32')('requires an existing directory before ".." in a link target', async () => {
      writeFileSync(path('file'), 'old')
      for (const [name, error] of [['file', 'NotADirectory'], ['missing', 'NotFound']] as const) {
        symlinkSync(name + '/../dest', path(name + '-link'))
        await rejects(ctx.fs.file(url(name + '-link')).write('data', { atomic: true }), error)
      }
      expect(existsSync(path('dest'))).to.be.false
    })

    it.skipIf(process.platform === 'win32')('writes a new read-only file atomically, with explicit or default permissions', async () => {
      const previous = process.umask(0o222)
      try {
        await ctx.fs.file(url('default')).write('data', { atomic: true })
        await ctx.fs.file(url('explicit')).write('more', { atomic: true, mode: 0o400 })
        expect(readFileSync(path('default'), 'utf8')).to.equal('data')
        expect(readFileSync(path('explicit'), 'utf8')).to.equal('more')
        expect(statSync(path('default')).mode & 0o777).to.equal(0o444)
        expect(statSync(path('explicit')).mode & 0o777).to.equal(0o400)
      } finally {
        process.umask(previous)
      }
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

  describe.runIf(process.platform !== 'win32')('FIFO', () => {
    it('reads a FIFO', async () => {
      execFileSync('mkfifo', [path('fifo')])
      const reading = ctx.fs.file(url('fifo')).text()
      await writeFile(path('fifo'), 'foo')
      expect(await reading).to.equal('foo')
    })

    it('reads no more of a FIFO than a bounded range', async () => {
      execFileSync('mkfifo', [path('fifo')])
      const fd = openSync(path('fifo'), constants.O_RDWR | constants.O_NONBLOCK)
      try {
        writeSync(fd, 'abcdef')
        expect(await ctx.fs.file(url('fifo')).slice(0, 2).text()).to.equal('ab')
        expect(await ctx.fs.file(url('fifo')).slice(1, 2).text()).to.equal('d')
        expect(await ctx.fs.file(url('fifo')).slice(4, 4).text()).to.equal('')
        expect(await ctx.fs.file(url('fifo')).slice(-1).slice(1).text()).to.equal('')
        const buffer = Buffer.alloc(8)
        expect(buffer.subarray(0, readSync(fd, buffer)).toString()).to.equal('ef')
      } finally {
        closeSync(fd)
      }
    })

    it('finishes bounded results with negative bounds while the FIFO writer is still open', async ({ onTestFinished }) => {
      execFileSync('mkfifo', [path('fifo')])
      const fd = openSync(path('fifo'), constants.O_RDWR | constants.O_NONBLOCK)
      onTestFinished(() => closeSync(fd))
      writeSync(fd, 'abc')
      expect(await ctx.fs.file(url('fifo')).slice(0, -1).slice(0, 2).text()).to.equal('ab')
      writeSync(fd, 'abcdefgh')
      expect(await ctx.fs.file(url('fifo')).slice(-2, 3).text()).to.equal('')
    })

    it('reads a range of a FIFO', async () => {
      execFileSync('mkfifo', [path('fifo')])
      for (const [start, end, expected] of [[0, 2, 'ab'], [1, undefined, 'bc'], [-2, undefined, 'bc'], [1, -1, 'b']] as const) {
        const reading = ctx.fs.file(url('fifo')).slice(start, end).text()
        await writeFile(path('fifo'), 'abc')
        expect(await reading, `slice(${start}, ${end})`).to.equal(expected)
      }
    })
  })

  describe('read', () => {
    // the content read depends on whether the first read precedes the growth
    it('reads no more than a range of a file that grows after it is opened', async () => {
      writeFileSync(path('a.txt'), 'abc')
      const reader = ctx.fs.file(url('a.txt')).slice(10, 11).stream().getReader()
      await new Promise(resolve => setTimeout(resolve, 20))
      writeFileSync(path('a.txt'), 'abcdefghijklm')
      const chunks: Uint8Array[] = []
      for (let result; !(result = await reader.read()).done;) chunks.push(result.value)
      expect(['', 'k']).to.include(Buffer.concat(chunks).toString())
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
    it.skipIf(process.platform === 'win32')('fails to create a file exclusively at a dangling link, which the provider does not follow', async () => {
      const provider = new NodeFs(ctx, { mount: url('.').href + '/' })
      writeFileSync(path('src'), 'data')
      symlinkSync('missing', path('link'))
      await rejects(provider.copy(url('src'), url('link'), { exclusive: true }), 'AlreadyExists')
      await rejects(provider.write(url('link'), new Blob(['data']).stream(), { exclusive: true }), 'AlreadyExists')
      expect(await ctx.fs.readlink(url('link'))).to.equal('missing')
      expect(existsSync(path('missing'))).to.be.false
    })

    // `b/` is a second mount of the same disk, to which a copy is a read and a write
    async function mountB() {
      mkdirSync(path('b'))
      await ctx.use(NodeFs, { mount: pathToFileURL(path('b')).href + '/' })
    }

    it('creates the file once for two concurrent copies with `exclusive: true`', async () => {
      writeFileSync(path('a.txt'), 'foo')
      writeFileSync(path('b.txt'), 'bar')
      const results = await Promise.allSettled([
        ctx.fs.copy(url('a.txt'), url('c.txt'), { exclusive: true }),
        ctx.fs.copy(url('b.txt'), url('c.txt'), { exclusive: true }),
      ])
      const created = results.findIndex(result => result.status === 'fulfilled')
      expect(results.filter(result => result.status === 'fulfilled')).to.have.length(1)
      expect((results[1 - created] as PromiseRejectedResult).reason).to.have.property('code', 'AlreadyExists')
      expect(await ctx.fs.file(url('c.txt')).text()).to.equal(['foo', 'bar'][created])
    })

    // links require a privilege on Windows
    it.skipIf(process.platform === 'win32')('resolves a dangling link at the destination as the file system does, with `exclusive: true`', async () => {
      writeFileSync(path('a.txt'), 'foo')
      mkdirSync(path('real/deep'), { recursive: true })
      symlinkSync('real/deep', path('shortcut'))
      // `..` follows the link `shortcut`, and a trailing separator names a directory
      symlinkSync('shortcut/../created.txt', path('link'))
      symlinkSync('missing/', path('slash'))
      await ctx.fs.copy(url('a.txt'), url('link'), { exclusive: true })
      expect(readFileSync(path('real/created.txt'), 'utf8')).to.equal('foo')
      expect(existsSync(path('created.txt'))).to.be.false
      expect(await ctx.fs.copy(url('a.txt'), url('slash'), { exclusive: true }).catch(error => error)).to.be.instanceOf(FsError)
      expect(existsSync(path('missing'))).to.be.false
    })

    // as above
    it.skipIf(process.platform === 'win32')('fails on a loop of links at the destination with the error of the loop', async () => {
      writeFileSync(path('a.txt'), 'foo')
      symlinkSync('loop', path('loop'))
      for (const exclusive of [false, true]) {
        const error = await ctx.fs.copy(url('a.txt'), url('loop'), { exclusive }).catch(error => error)
        expect(error).to.be.instanceOf(FsError)
        if (exclusive) expect(error.code).to.equal('InvalidPath')
        else expect(error.cause).to.have.property('code', 'ELOOP')
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
