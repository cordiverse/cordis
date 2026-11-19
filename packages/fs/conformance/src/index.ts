import Fs, { DirEntry, EntryType, FsError } from '@cordisjs/fs'
import { Context, Fiber } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

export interface ConformanceOptions {
  /** mounts the provider under test, and returns the base URL of an empty directory to work in */
  setup(ctx: Context): Promise<URL>
  /** optional cleanup after each test */
  teardown?(): Promise<void>
  capabilities?: Capabilities
}

export interface Capabilities {
  /** whether the provider supports symbolic links; without them, `symlink()` and `readlink()` fail with `NotSupported` */
  symlink?: boolean
}

const windows = process.platform === 'win32'

async function rejects(promise: Promise<unknown>, code: FsError.Code) {
  const error = await promise.then(() => undefined, error => error)
  expect(error).to.be.instanceOf(FsError)
  expect(error.code).to.equal(code)
  return error as FsError
}

/**
 * Define the test suites of the semantics that every provider shares. Each
 * test runs in a new context with the `fs` service, in which `setup()` mounts
 * the provider under test.
 */
export function conformance(name: string, options: ConformanceOptions) {
  const symlinks = !!options.capabilities?.symlink

  describe(name, () => {
    let fiber: Fiber | undefined
    let ctx: Context
    let base: URL

    beforeEach(async () => {
      ctx = new Context()
      fiber = await ctx.use(Fs)
      base = await options.setup(ctx)
    })

    afterEach(async () => {
      await fiber?.dispose()
      fiber = undefined
      await options.teardown?.()
    })

    // the location of a reference relative to the working directory
    function url(path: string) {
      return new URL(path, base)
    }

    // writes a file, creating its parent directories
    async function write(path: string, content: string | Uint8Array<ArrayBuffer> = '') {
      await ctx.fs.mkdir(new URL('.', url(path)), { recursive: true })
      await ctx.fs.file(url(path)).write(content)
    }

    function text(path: string) {
      return ctx.fs.file(url(path)).text()
    }

    async function list(path: string) {
      const entries: DirEntry[] = []
      for await (const entry of ctx.fs.readdir(url(path))) entries.push(entry)
      return entries
    }

    // the names and the types of the entries of a directory, sorted by name
    async function names(path: string) {
      const entries = await list(path)
      return entries
        .map(({ name, type }) => [name, type] as [string, EntryType])
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    }

    describe('file', () => {
      it('reads the current content', async () => {
        await write('a.txt', 'foo')
        expect(await text('a.txt')).to.equal('foo')
        await write('a.txt', 'bar')
        expect(await text('a.txt')).to.equal('bar')
      })

      it('reads and writes a content of several chunks', async () => {
        const content = new Uint8Array(200 * 1024).map((_, index) => index % 251)
        await write('a.bin', content)
        expect(await ctx.fs.file(url('a.bin')).bytes()).to.deep.equal(content)

        await ctx.fs.file(url('b.bin')).write(ctx.fs.file(url('a.bin')).stream())
        expect(await ctx.fs.file(url('b.bin')).bytes()).to.deep.equal(content)
      })

      it('does not create the parent directory', async () => {
        await rejects(ctx.fs.file(url('missing/a.txt')).write('foo'), 'NotFound')
        expect(await ctx.fs.exists(url('missing'))).to.equal(false)
      })

      it('rejects a write with the error of the stream', async () => {
        const error = new Error('aborted')
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('foo'))
            controller.error(error)
          },
        })
        expect(await ctx.fs.file(url('a.txt')).write(body).catch(error => error)).to.equal(error)
      })

      it('fails to read a missing file with the location', async () => {
        const file = ctx.fs.file(url('missing.txt'))
        const error = await rejects(file.text(), 'NotFound')
        expect(error.url?.href).to.equal(file.url.href)
      })

      it('fails to read or write a directory', async () => {
        await ctx.fs.mkdir(url('dir'))
        await rejects(ctx.fs.file(url('dir')).text(), 'IsADirectory')
        await rejects(ctx.fs.file(url('dir')).write('foo'), 'IsADirectory')
      })

      it('fails to read or write a location named with a trailing separator', async () => {
        await ctx.fs.mkdir(url('dir'))
        await rejects(ctx.fs.file(url('dir/')).text(), 'IsADirectory')
        await rejects(ctx.fs.file(url('missing/')).write('foo'), 'IsADirectory')
        expect(await ctx.fs.exists(url('missing'))).to.equal(false)
      })

      it('fails to read below a file', async () => {
        await write('a.txt')
        await rejects(ctx.fs.file(url('a.txt/b.txt')).text(), 'NotADirectory')
      })
    })

    describe('access', () => {
      it('resolves for an existing entry', async () => {
        await write('a.txt')
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.access(url('a.txt'), 'write')
        await ctx.fs.access(url('dir'), 'write')
        await ctx.fs.access(url('dir/'), 'write')
      })

      it('rejects a missing entry', async () => {
        await rejects(ctx.fs.access(url('missing.txt'), 'write'), 'NotFound')
      })
    })

    describe('stat', () => {
      it('reports a file with the length of its content', async () => {
        await write('a.txt', 'foo')
        const stats = await ctx.fs.stat(url('a.txt'))
        expect(stats.type).to.equal('file')
        expect(stats.size).to.equal(3)
        expect(stats.mtime).to.be.instanceOf(Date)
        expect(Number.isNaN(stats.mtime.getTime())).to.equal(false)
      })

      it('reports a directory', async () => {
        await ctx.fs.mkdir(url('dir'))
        expect((await ctx.fs.stat(url('dir'))).type).to.equal('directory')
        expect((await ctx.fs.stat(url('dir/'))).type).to.equal('directory')
        expect((await ctx.fs.stat(base)).type).to.equal('directory')
      })

      it('fails on a missing location', async () => {
        await rejects(ctx.fs.stat(url('missing.txt')), 'NotFound')
        await rejects(ctx.fs.stat(url('missing/a.txt')), 'NotFound')
      })

      it('requires a directory for a trailing separator', async () => {
        await write('a.txt')
        await rejects(ctx.fs.stat(url('a.txt/')), 'NotADirectory')
        await rejects(ctx.fs.stat(url('a.txt/b.txt')), 'NotADirectory')
      })
    })

    describe('exists', () => {
      it('resolves to whether an entry exists', async () => {
        await write('a.txt')
        await ctx.fs.mkdir(url('dir'))
        expect(await ctx.fs.exists(url('a.txt'))).to.equal(true)
        expect(await ctx.fs.exists(url('dir'))).to.equal(true)
        expect(await ctx.fs.exists(url('dir/'))).to.equal(true)
        expect(await ctx.fs.exists(url('missing.txt'))).to.equal(false)
        expect(await ctx.fs.exists(url('missing/a.txt'))).to.equal(false)
      })

      it('resolves to `false` for a location below a file', async () => {
        await write('a.txt')
        expect(await ctx.fs.exists(url('a.txt/'))).to.equal(false)
        expect(await ctx.fs.exists(url('a.txt/b.txt'))).to.equal(false)
      })
    })

    describe('readdir', () => {
      it('lists the names, the types and the locations of the entries', async () => {
        await write('dir/a.txt')
        await ctx.fs.mkdir(url('dir/sub'))
        expect(await names('dir')).to.deep.equal([['a.txt', 'file'], ['sub', 'directory']])
        const entries = await list('dir/')
        expect(entries.map(entry => entry.url.href).sort()).to.deep.equal([url('dir/a.txt').href, url('dir/sub').href])
      })

      it('lists an empty directory', async () => {
        await ctx.fs.mkdir(url('dir'))
        expect(await list('dir')).to.deep.equal([])
      })

      it('gives the location of an entry whose name contains characters of a URL', async () => {
        const name = 'a #%b.txt'
        await write('dir/' + encodeURIComponent(name), 'foo')
        const [entry] = await list('dir')
        expect(entry.name).to.equal(name)
        expect(await ctx.fs.file(entry.url).text()).to.equal('foo')
      })

      it('fails from the iteration on a file or a missing location', async () => {
        await write('a.txt')
        const iterable = ctx.fs.readdir(url('a.txt'))
        await rejects(list('a.txt'), 'NotADirectory')
        await rejects(iterable[Symbol.asyncIterator]().next(), 'NotADirectory')
        await rejects(list('a.txt/'), 'NotADirectory')
        await rejects(list('missing'), 'NotFound')
      })
    })

    describe('mkdir', () => {
      it('creates a directory', async () => {
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.mkdir(url('dir/sub/'))
        expect((await ctx.fs.stat(url('dir/sub'))).type).to.equal('directory')
      })

      it('fails on an existing entry', async () => {
        await ctx.fs.mkdir(url('dir'))
        await write('a.txt', 'foo')
        await rejects(ctx.fs.mkdir(url('dir')), 'AlreadyExists')
        await rejects(ctx.fs.mkdir(url('a.txt')), 'AlreadyExists')
        expect(await text('a.txt')).to.equal('foo')
      })

      it('fails on a missing parent', async () => {
        await rejects(ctx.fs.mkdir(url('missing/dir')), 'NotFound')
        expect(await ctx.fs.exists(url('missing'))).to.equal(false)
      })

      it('creates the missing parents with `recursive`', async () => {
        await ctx.fs.mkdir(url('a/b/c'), { recursive: true })
        expect((await ctx.fs.stat(url('a/b/c'))).type).to.equal('directory')
      })

      it('accepts an existing directory with `recursive`', async () => {
        await write('dir/a.txt', 'foo')
        await ctx.fs.mkdir(url('dir'), { recursive: true })
        await ctx.fs.mkdir(base, { recursive: true })
        expect(await text('dir/a.txt')).to.equal('foo')
      })

      it('fails on an existing non-directory with `recursive`', async () => {
        await write('a.txt', 'foo')
        await rejects(ctx.fs.mkdir(url('a.txt'), { recursive: true }), 'AlreadyExists')
        await rejects(ctx.fs.mkdir(url('a.txt/dir'), { recursive: true }), 'NotADirectory')
        expect(await text('a.txt')).to.equal('foo')
      })
    })

    describe('rename', () => {
      it('replaces an existing file', async () => {
        await write('a.txt', 'foo')
        await write('b.txt', 'bar')
        await ctx.fs.rename(url('a.txt'), url('b.txt'))
        expect(await ctx.fs.exists(url('a.txt'))).to.equal(false)
        expect(await text('b.txt')).to.equal('foo')
      })

      it('moves a directory with its entries, and replaces an empty one', async () => {
        await write('src/a.txt', 'foo')
        await ctx.fs.mkdir(url('dest'))
        await ctx.fs.rename(url('src'), url('dest/'))
        expect(await text('dest/a.txt')).to.equal('foo')
        expect(await ctx.fs.exists(url('src'))).to.equal(false)
      })

      // Windows reports a directory as the target of a rename as `EPERM`, which
      // is classified as `Busy` without further I/O
      it.skipIf(windows)('fails on a non-empty directory', async () => {
        await ctx.fs.mkdir(url('a'))
        await write('b/c.txt')
        await rejects(ctx.fs.rename(url('a'), url('b')), 'DirectoryNotEmpty')
        expect(await ctx.fs.exists(url('b/c.txt'))).to.equal(true)
      })

      // as above
      it.skipIf(windows)('fails between a file and a directory', async () => {
        await write('a.txt', 'foo')
        await ctx.fs.mkdir(url('dir'))
        await rejects(ctx.fs.rename(url('a.txt'), url('dir')), 'IsADirectory')
        await rejects(ctx.fs.rename(url('dir'), url('a.txt')), 'NotADirectory')
        expect(await text('a.txt')).to.equal('foo')
      })

      it('requires a directory for a trailing separator of the destination', async () => {
        await write('a.txt', 'foo')
        await rejects(ctx.fs.rename(url('a.txt'), url('b/')), 'NotADirectory')
        expect(await text('a.txt')).to.equal('foo')

        await ctx.fs.mkdir(url('src'))
        await ctx.fs.rename(url('src'), url('b/'))
        expect((await ctx.fs.stat(url('b'))).type).to.equal('directory')
      })

      it('does not move a directory into itself', async () => {
        await write('dir/a.txt', 'foo')
        expect(await ctx.fs.rename(url('dir'), url('dir/sub')).catch(error => error)).to.be.instanceOf(FsError)
        expect(await text('dir/a.txt')).to.equal('foo')
      })

      it('fails on a missing source or a missing parent of the destination', async () => {
        await write('a.txt', 'foo')
        await rejects(ctx.fs.rename(url('missing.txt'), url('b.txt')), 'NotFound')
        await rejects(ctx.fs.rename(url('a.txt'), url('missing/b.txt')), 'NotFound')
        expect(await text('a.txt')).to.equal('foo')
      })
    })

    describe('remove', () => {
      it('removes a file or an empty directory', async () => {
        await write('a.txt')
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.remove(url('a.txt'))
        await ctx.fs.remove(url('dir'))
        expect(await ctx.fs.exists(url('a.txt'))).to.equal(false)
        expect(await ctx.fs.exists(url('dir'))).to.equal(false)
      })

      it('fails on a non-empty directory', async () => {
        await write('dir/a.txt')
        await rejects(ctx.fs.remove(url('dir')), 'DirectoryNotEmpty')
        expect(await ctx.fs.exists(url('dir/a.txt'))).to.equal(true)
      })

      it('removes a directory with its entries with `recursive`', async () => {
        await write('dir/a.txt')
        await write('dir/sub/b.txt')
        await write('c.txt')
        await ctx.fs.remove(url('dir'), { recursive: true })
        expect(await ctx.fs.exists(url('dir'))).to.equal(false)
        expect(await names('.')).to.deep.equal([['c.txt', 'file']])
      })

      it('removes a file with `recursive`', async () => {
        await write('a.txt')
        await ctx.fs.remove(url('a.txt'), { recursive: true })
        expect(await ctx.fs.exists(url('a.txt'))).to.equal(false)
      })

      it('requires a directory for a trailing separator', async () => {
        await write('a.txt')
        await rejects(ctx.fs.remove(url('a.txt/')), 'NotADirectory')
        await rejects(ctx.fs.remove(url('a.txt/'), { recursive: true }), 'NotADirectory')
        expect(await ctx.fs.exists(url('a.txt'))).to.equal(true)
      })

      it('fails on a missing location unless forced', async () => {
        await rejects(ctx.fs.remove(url('missing.txt')), 'NotFound')
        await rejects(ctx.fs.remove(url('missing'), { recursive: true }), 'NotFound')
        await ctx.fs.remove(url('missing.txt'), { force: true })
        await ctx.fs.remove(url('missing'), { recursive: true, force: true })
      })
    })

    describe('copy', () => {
      it('copies a file, and replaces an existing one', async () => {
        await write('a.txt', 'foo')
        await ctx.fs.copy(url('a.txt'), url('b.txt'))
        expect(await text('b.txt')).to.equal('foo')
        await write('a.txt', 'bar')
        await ctx.fs.copy(url('a.txt'), url('b.txt'))
        expect(await text('b.txt')).to.equal('bar')
        expect(await text('a.txt')).to.equal('bar')
      })

      it('keeps an existing file with `overwrite: false`', async () => {
        await write('a.txt', 'foo')
        await write('b.txt', 'bar')
        await rejects(ctx.fs.copy(url('a.txt'), url('b.txt'), { overwrite: false }), 'AlreadyExists')
        expect(await text('b.txt')).to.equal('bar')
        await ctx.fs.copy(url('a.txt'), url('c.txt'), { overwrite: false })
        expect(await text('c.txt')).to.equal('foo')
      })

      it('copies a directory with its entries with `recursive`', async () => {
        await write('src/a.txt', 'foo')
        await write('src/sub/b.txt', 'bar')
        await ctx.fs.mkdir(url('src/empty'))
        await rejects(ctx.fs.copy(url('src'), url('dest')), 'IsADirectory')
        expect(await ctx.fs.exists(url('dest'))).to.equal(false)

        await ctx.fs.copy(url('src'), url('dest'), { recursive: true })
        expect(await names('dest')).to.deep.equal([['a.txt', 'file'], ['empty', 'directory'], ['sub', 'directory']])
        expect(await text('dest/a.txt')).to.equal('foo')
        expect(await text('dest/sub/b.txt')).to.equal('bar')
        expect(await text('src/a.txt')).to.equal('foo')
      })

      it('merges a directory into an existing one', async () => {
        await write('src/a.txt', 'foo')
        await write('src/sub/b.txt', 'bar')
        await write('dest/a.txt', 'old')
        await write('dest/sub/c.txt', 'baz')
        await ctx.fs.copy(url('src'), url('dest'), { recursive: true })
        expect(await text('dest/a.txt')).to.equal('foo')
        expect(await text('dest/sub/b.txt')).to.equal('bar')
        expect(await text('dest/sub/c.txt')).to.equal('baz')
      })

      it('keeps the existing files of a merge with `overwrite: false`', async () => {
        await write('src/a.txt', 'foo')
        await write('dest/a.txt', 'old')
        await rejects(ctx.fs.copy(url('src'), url('dest'), { recursive: true, overwrite: false }), 'AlreadyExists')
        expect(await text('dest/a.txt')).to.equal('old')
      })

      it('fails between a file and a directory', async () => {
        await write('a.txt', 'foo')
        await write('dir/b.txt', 'bar')
        await rejects(ctx.fs.copy(url('a.txt'), url('dir')), 'IsADirectory')
        await rejects(ctx.fs.copy(url('dir'), url('a.txt'), { recursive: true }), 'NotADirectory')
        expect(await text('a.txt')).to.equal('foo')
        expect(await names('dir')).to.deep.equal([['b.txt', 'file']])
      })

      it('fails on a destination at or below the source without changes', async () => {
        await write('dir/a.txt', 'foo')
        await rejects(ctx.fs.copy(url('dir'), url('dir/sub'), { recursive: true }), 'InvalidPath')
        await rejects(ctx.fs.copy(url('dir/'), url('dir'), { recursive: true }), 'InvalidPath')
        await rejects(ctx.fs.copy(url('dir/a.txt'), url('dir/a.txt')), 'InvalidPath')
        expect(await names('dir')).to.deep.equal([['a.txt', 'file']])
        expect(await text('dir/a.txt')).to.equal('foo')
      })

      it('does not create the parent of the destination', async () => {
        await write('a.txt', 'foo')
        await write('dir/b.txt', 'bar')
        await rejects(ctx.fs.copy(url('a.txt'), url('missing/a.txt')), 'NotFound')
        await rejects(ctx.fs.copy(url('dir'), url('missing/dir'), { recursive: true }), 'NotFound')
        expect(await ctx.fs.exists(url('missing'))).to.equal(false)
      })

      it('fails on a missing source', async () => {
        await rejects(ctx.fs.copy(url('missing.txt'), url('b.txt')), 'NotFound')
        expect(await ctx.fs.exists(url('b.txt'))).to.equal(false)
      })
    })

    describe.runIf(symlinks)('symlink', () => {
      // A link to a file requires a privilege on Windows, while a link to a
      // directory may be created as a junction, which stores the absolute target.
      it.skipIf(windows)('stores the target as given, relative to the directory of the link', async () => {
        await write('dir/a.txt', 'foo')
        await ctx.fs.symlink('a.txt', url('dir/link'))
        expect(await ctx.fs.readlink(url('dir/link'))).to.equal('a.txt')
        expect(await text('dir/link')).to.equal('foo')
      })

      it('creates a link to a directory', async () => {
        await write('dir/a.txt', 'foo')
        await ctx.fs.symlink('dir', url('link'))
        expect(await text('link/a.txt')).to.equal('foo')
      })

      it('fails on an existing entry', async () => {
        await write('a.txt', 'foo')
        await ctx.fs.mkdir(url('dir'))
        await rejects(ctx.fs.symlink('dir', url('a.txt')), 'AlreadyExists')
        await rejects(ctx.fs.symlink('a.txt', url('dir')), 'AlreadyExists')
        expect(await text('a.txt')).to.equal('foo')
      })

      it('fails to read a location that is not a link', async () => {
        await write('a.txt')
        await ctx.fs.mkdir(url('dir'))
        await rejects(ctx.fs.readlink(url('a.txt')), 'NotALink')
        await rejects(ctx.fs.readlink(url('dir')), 'NotALink')
        await rejects(ctx.fs.readlink(url('missing')), 'NotFound')
      })

      it('reports a link itself with `follow: false`', async () => {
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.symlink('dir', url('link'))
        expect((await ctx.fs.stat(url('link'))).type).to.equal('directory')
        expect((await ctx.fs.stat(url('link'), { follow: false })).type).to.equal('symlink')
        // a trailing separator follows a link in the last component
        expect((await ctx.fs.stat(url('link/'), { follow: false })).type).to.equal('directory')
      })

      it.skipIf(windows)('reports a dangling link only with `follow: false`', async () => {
        await ctx.fs.symlink('missing', url('link'))
        await rejects(ctx.fs.stat(url('link')), 'NotFound')
        expect((await ctx.fs.stat(url('link'), { follow: false })).type).to.equal('symlink')
        expect(await ctx.fs.exists(url('link'))).to.equal(false)
      })

      it('lists a link with its own type', async () => {
        await ctx.fs.mkdir(url('dir/target'), { recursive: true })
        await ctx.fs.symlink('target', url('dir/link'))
        expect(await names('dir')).to.deep.equal([['link', 'symlink'], ['target', 'directory']])
      })

      it('accepts an existing directory through a link with `recursive`', async () => {
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.symlink('dir', url('link'))
        await ctx.fs.mkdir(url('link'), { recursive: true })
        await rejects(ctx.fs.mkdir(url('link')), 'AlreadyExists')
      })

      it('removes a link without its target', async () => {
        await write('dir/a.txt')
        await ctx.fs.symlink('dir', url('link'))
        await ctx.fs.remove(url('link'))
        expect(await ctx.fs.exists(url('link'))).to.equal(false)
        expect(await ctx.fs.exists(url('dir/a.txt'))).to.equal(true)
      })

      it('removes a link without its target with `recursive`, also named with a trailing separator', async () => {
        await write('dir/a.txt')
        await ctx.fs.symlink('dir', url('link'))
        await ctx.fs.symlink('dir', url('other'))
        await ctx.fs.remove(url('link'), { recursive: true })
        await ctx.fs.remove(url('other/'), { recursive: true })
        expect(await names('.')).to.deep.equal([['dir', 'directory']])
        expect(await ctx.fs.exists(url('dir/a.txt'))).to.equal(true)
      })

      it('removes the links below a directory without their targets with `recursive`', async () => {
        await write('target/a.txt')
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.symlink('../target', url('dir/link'))
        await ctx.fs.remove(url('dir'), { recursive: true })
        expect(await ctx.fs.exists(url('dir'))).to.equal(false)
        expect(await ctx.fs.exists(url('target/a.txt'))).to.equal(true)
      })

      it('removes a link named with a trailing separator without its target', async () => {
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.symlink('dir', url('link'))
        await ctx.fs.remove(url('link/'))
        expect(await ctx.fs.exists(url('link'))).to.equal(false)
        expect(await ctx.fs.exists(url('dir'))).to.equal(true)
      })

      // creating a link to a file requires a privilege on Windows
      it.skipIf(windows)('keeps a link to a file named with a trailing separator', async () => {
        await write('a.txt')
        await ctx.fs.symlink('a.txt', url('link'))
        await rejects(ctx.fs.remove(url('link/')), 'NotADirectory')
        expect((await ctx.fs.stat(url('link'), { follow: false })).type).to.equal('symlink')
        expect(await ctx.fs.exists(url('a.txt'))).to.equal(true)
      })

      it('renames a link named with a trailing separator without its target', async () => {
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.symlink('dir', url('link'))
        await ctx.fs.rename(url('link/'), url('moved'))
        expect((await ctx.fs.stat(url('moved'), { follow: false })).type).to.equal('symlink')
        expect(await ctx.fs.exists(url('link'))).to.equal(false)
        expect(await ctx.fs.exists(url('dir'))).to.equal(true)
      })

      it('does not replace the target of a link named with a trailing separator', async () => {
        await write('src/a.txt')
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.symlink('dir', url('link'))
        // the link may be replaced, or the rename may fail
        await ctx.fs.rename(url('src'), url('link/')).catch(() => {})
        expect(await ctx.fs.exists(url('dir/a.txt'))).to.equal(false)
      })

      // as above
      it.skipIf(windows)('copies a link as a link', async () => {
        await write('dir/a.txt', 'foo')
        await ctx.fs.symlink('a.txt', url('dir/link'))
        await ctx.fs.copy(url('dir'), url('copied'), { recursive: true })
        expect(await ctx.fs.readlink(url('copied/link'))).to.equal('a.txt')
        await ctx.fs.copy(url('dir/link'), url('link'))
        expect(await ctx.fs.readlink(url('link'))).to.equal('a.txt')
        await rejects(ctx.fs.copy(url('dir/link'), url('link'), { overwrite: false }), 'AlreadyExists')
      })

      // as above
      it.skipIf(windows)('copies a file through a dangling link, also with `overwrite: false`', async () => {
        await write('a.txt', 'foo')
        await ctx.fs.symlink('target.txt', url('link'))
        await ctx.fs.copy(url('a.txt'), url('link'), { overwrite: false })
        expect(await text('target.txt')).to.equal('foo')
        expect((await ctx.fs.stat(url('link'), { follow: false })).type).to.equal('symlink')
        await rejects(ctx.fs.copy(url('a.txt'), url('link'), { overwrite: false }), 'AlreadyExists')
      })

      it.skipIf(windows)('copies what a link points to with `dereference`', async () => {
        await write('dir/a.txt', 'foo')
        await ctx.fs.symlink('a.txt', url('dir/link'))
        await ctx.fs.symlink('dir', url('outer'))
        await ctx.fs.copy(url('outer'), url('copied'), { recursive: true, dereference: true })
        expect((await ctx.fs.stat(url('copied'), { follow: false })).type).to.equal('directory')
        expect((await ctx.fs.stat(url('copied/link'), { follow: false })).type).to.equal('file')
        expect(await text('copied/link')).to.equal('foo')
      })
    })

    describe.runIf(!symlinks)('symlink', () => {
      it('fails to create or read a link with `NotSupported`', async () => {
        await write('a.txt')
        await rejects(ctx.fs.symlink('a.txt', url('link')), 'NotSupported')
        await rejects(ctx.fs.readlink(url('a.txt')), 'NotSupported')
      })
    })

    describe('location', () => {
      it('does not apply an operation on a directory location to a file', async () => {
        await write('a.txt', 'foo')
        const dir = url('a.txt/')
        await rejects(ctx.fs.file(dir).text(), 'IsADirectory')
        await rejects(ctx.fs.file(dir).write('bar'), 'IsADirectory')
        // each operation is started after the previous one has settled
        for (const operation of [
          () => ctx.fs.access(dir, 'write'),
          () => ctx.fs.stat(dir),
          () => list('a.txt/'),
          () => ctx.fs.rename(dir, url('b.txt')),
          () => ctx.fs.copy(dir, url('b.txt')),
          () => ctx.fs.remove(dir),
        ]) {
          await rejects(operation(), 'NotADirectory')
        }
        expect(await text('a.txt')).to.equal('foo')
      })
    })
  })
}
