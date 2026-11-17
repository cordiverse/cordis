import { Context, Fiber, FiberState } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import Fs, { FsError, WatchOptions } from '@cordisjs/fs'
import MemoryFs from '../src/index.ts'

async function rejects(promise: Promise<unknown>, code: FsError.Code) {
  const error = await promise.then(() => undefined, error => error)
  expect(error).to.be.instanceOf(FsError)
  expect(error.code).to.equal(code)
  return error as FsError
}

describe('MemoryFs', () => {
  const fibers: Fiber[] = []

  afterEach(async () => {
    for (const fiber of fibers.splice(0)) await fiber.dispose()
  })

  // a context with `fs` and no provider
  async function context() {
    const ctx = new Context()
    fibers.push(await ctx.plugin(Fs, { baseUrl: 'memory:///' }))
    return ctx
  }

  async function setup(files: MemoryFs.Tree = {}) {
    const ctx = await context()
    fibers.push(await ctx.plugin(MemoryFs, { files }))
    return ctx
  }

  // the state of `MemoryFs` once it has started or failed
  async function start(ctx: Context, config: MemoryFs.Config) {
    const fiber = ctx.plugin(MemoryFs, config)
    fibers.push(fiber)
    await fiber.await().catch(() => {})
    return fiber.state
  }

  describe('mount', () => {
    it('mounts at `memory:` by default, or at `config.mount`', async () => {
      const ctx = await setup({ 'a.txt': 'foo' })
      fibers.push(await ctx.plugin(MemoryFs, { mount: 'other:', files: { 'a.txt': 'bar' } }))
      fibers.push(await ctx.plugin(MemoryFs, { mount: 'memory://data', files: { 'a.txt': 'baz' } }))
      expect(await ctx.fs.file('memory:///a.txt').text()).to.equal('foo')
      expect(await ctx.fs.file('other:///a.txt').text()).to.equal('bar')
      expect(await ctx.fs.file('memory://data/a.txt').text()).to.equal('baz')
    })

    it('takes absolute keys for a mount at a scheme whose URLs require a host', async () => {
      const ctx = await setup()
      expect(await start(ctx, { mount: 'https:' })).to.equal(FiberState.ACTIVE)
      fibers.push(await ctx.plugin(MemoryFs, { mount: 'wss:', files: { 'wss://app/a.txt': 'foo' } }))
      expect(await ctx.fs.file('wss://app/a.txt').text()).to.equal('foo')
    })

    it('takes absolute keys of any scheme for a mount at the empty string', async () => {
      const ctx = await context()
      fibers.push(await ctx.plugin(MemoryFs, { mount: '', files: { 'https://app/a.txt': 'foo', 'file:///b.txt': 'bar' } }))
      expect(await ctx.fs.file('https://app/a.txt').text()).to.equal('foo')
      expect(await ctx.fs.file('file:///b.txt').text()).to.equal('bar')
    })

    it.each([
      ['memory://data/sub/', '../a.txt'],
      ['memory://data/', 'memory://other/a.txt'],
      ['other:', 'memory:///a.txt'],
      ['ftp:', 'a.txt'],
      ['', 'a.txt'],
    ])('fails to start at the mount %j with the key %j', async (mount, key) => {
      const ctx = await context()
      expect(await start(ctx, { mount, files: { [key]: '' } })).to.equal(FiberState.FAILED)
    })
  })

  describe('files', () => {
    it('creates the initial entries and their parent directories', async () => {
      const ctx = await setup({
        'a/b.txt': 'foo',
        'dir': {
          'c.txt': 'bar',
          'nested/d.bin': new Uint8Array([1, 2, 3]),
          'empty': {},
        },
      })
      expect(await ctx.fs.file('a/b.txt').text()).to.equal('foo')
      expect(await ctx.fs.file('dir/c.txt').text()).to.equal('bar')
      expect(await ctx.fs.file('dir/nested/d.bin').bytes()).to.deep.equal(new Uint8Array([1, 2, 3]))
      await ctx.fs.remove('dir/empty/')
    })

    it('rejects a file below another file', async () => {
      const ctx = await context()
      expect(await start(ctx, { files: { 'a': 'foo', 'a/b': 'bar' } })).to.equal(FiberState.FAILED)
    })
  })

  describe('read', () => {
    it('reads the current content', async () => {
      const ctx = await setup({ 'a.txt': 'foo' })
      const file = ctx.fs.file('a.txt')
      expect(await file.text()).to.equal('foo')
      await file.write('bar')
      expect(await file.text()).to.equal('bar')
    })

    it('reads the content of the file when the stream is created', async () => {
      const ctx = await setup({ 'a.txt': 'foo' })
      const stream = ctx.fs.file('a.txt').stream()
      await ctx.fs.file('a.txt').write('bar')
      expect(await new Response(stream).text()).to.equal('foo')
    })

    it('keeps the content apart from the initial data and from the chunks read', async () => {
      const data = Buffer.from('foo')
      const ctx = await setup({ 'a.txt': data })
      data.fill(0)
      for await (const chunk of ctx.fs.file('a.txt').stream()) chunk.fill(0)
      expect(await ctx.fs.file('a.txt').text()).to.equal('foo')
    })

    it('fails on a missing file with the location', async () => {
      const ctx = await setup()
      const file = ctx.fs.file('missing.txt')
      const error = await rejects(file.text(), 'NotFound')
      expect(error.url?.href).to.equal(file.url.href)
    })

    it('fails on a directory', async () => {
      const ctx = await setup({ 'dir/a.txt': '' })
      await rejects(ctx.fs.file('dir').text(), 'IsADirectory')
      await rejects(ctx.fs.file('a.txt/').text(), 'IsADirectory')
    })

    it('fails below a file', async () => {
      const ctx = await setup({ 'a.txt': '' })
      await rejects(ctx.fs.file('a.txt/b.txt').text(), 'NotADirectory')
    })
  })

  describe('write', () => {
    it('creates a file or replaces its content', async () => {
      const ctx = await setup()
      await ctx.fs.file('a.txt').write('foo')
      expect(await ctx.fs.file('a.txt').text()).to.equal('foo')
      await ctx.fs.file('a.txt').write(new Uint8Array([0x62]))
      expect(await ctx.fs.file('a.txt').text()).to.equal('b')
    })

    it('does not create the parent directory', async () => {
      const ctx = await setup()
      await rejects(ctx.fs.file('missing/a.txt').write('foo'), 'NotFound')
      await rejects(ctx.fs.access('missing', 'write'), 'NotFound')
    })

    it('fails on a directory', async () => {
      const ctx = await setup({ 'dir/a.txt': '' })
      await rejects(ctx.fs.file('dir').write('foo'), 'IsADirectory')
      await rejects(ctx.fs.file('b.txt/').write('foo'), 'IsADirectory')
      await rejects(ctx.fs.access('b.txt', 'write'), 'NotFound')
    })

    it('rejects with the error of the stream and keeps the previous content', async () => {
      const ctx = await setup({ 'a.txt': 'foo' })
      const error = new Error('aborted')
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('bar'))
          controller.error(error)
        },
      })
      expect(await ctx.fs.file('a.txt').write(body).catch(error => error)).to.equal(error)
      expect(await ctx.fs.file('a.txt').text()).to.equal('foo')
    })

    it('keeps each chunk of the body when the producer reuses its memory', async () => {
      const ctx = await setup()
      const chunk = new Uint8Array(1)
      const values = [...'ABC']
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!values.length) return controller.close()
          chunk[0] = values.shift()!.charCodeAt(0)
          controller.enqueue(chunk)
        },
      }, { highWaterMark: 0 })
      await ctx.fs.file('a.txt').write(body)
      expect(await ctx.fs.file('a.txt').text()).to.equal('ABC')
    })

    it('fails when the parent directory is removed while the body is consumed', async () => {
      const ctx = await setup({ 'dir/': {} })
      let resume!: () => void
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise<void>(resolve => resume = resolve)
          controller.enqueue(new TextEncoder().encode('foo'))
          controller.close()
        },
      })
      const write = ctx.fs.file('dir/a.txt').write(body)
      await new Promise(resolve => setTimeout(resolve))
      await ctx.fs.remove('dir')
      resume()
      await rejects(write, 'NotFound')
    })
  })

  describe('access', () => {
    it('resolves for an existing entry and rejects a missing one', async () => {
      const ctx = await setup({ 'dir/a.txt': '' })
      await ctx.fs.access('dir/a.txt', 'write')
      await ctx.fs.access('dir/', 'write')
      await rejects(ctx.fs.access('missing.txt', 'write'), 'NotFound')
      await rejects(ctx.fs.access('dir/a.txt/', 'write'), 'NotADirectory')
    })
  })

  describe('rename', () => {
    it('replaces an existing file', async () => {
      const ctx = await setup({ 'a.txt': 'foo', 'b.txt': 'bar' })
      await ctx.fs.rename('a.txt', 'b.txt')
      await rejects(ctx.fs.access('a.txt', 'write'), 'NotFound')
      expect(await ctx.fs.file('b.txt').text()).to.equal('foo')
    })

    it('moves a directory with its entries, and replaces an empty one', async () => {
      const ctx = await setup({ 'src/a.txt': 'foo', 'dest/': {} })
      await ctx.fs.rename('src', 'dest/')
      expect(await ctx.fs.file('dest/a.txt').text()).to.equal('foo')
      await rejects(ctx.fs.access('src', 'write'), 'NotFound')
    })

    it('fails on a non-empty directory', async () => {
      const ctx = await setup({ 'a/': {}, 'b/c.txt': '' })
      await rejects(ctx.fs.rename('a', 'b'), 'DirectoryNotEmpty')
      await ctx.fs.access('b/c.txt', 'write')
    })

    it('fails between a file and a directory', async () => {
      const ctx = await setup({ 'a.txt': 'foo', 'dir/': {} })
      await rejects(ctx.fs.rename('a.txt', 'dir'), 'IsADirectory')
      await rejects(ctx.fs.rename('dir', 'a.txt'), 'NotADirectory')
      await rejects(ctx.fs.rename('a.txt', 'b/'), 'NotADirectory')
      expect(await ctx.fs.file('a.txt').text()).to.equal('foo')
    })

    it('does not move a directory into itself', async () => {
      const ctx = await setup({ 'dir/a.txt': 'foo' })
      expect(await ctx.fs.rename('dir', 'dir/sub').catch(error => error)).to.be.instanceOf(FsError)
      expect(await ctx.fs.file('dir/a.txt').text()).to.equal('foo')
    })

    it('fails on a missing source or a missing parent of the destination', async () => {
      const ctx = await setup({ 'a.txt': 'foo' })
      await rejects(ctx.fs.rename('missing.txt', 'b.txt'), 'NotFound')
      await rejects(ctx.fs.rename('a.txt', 'missing/b.txt'), 'NotFound')
      expect(await ctx.fs.file('a.txt').text()).to.equal('foo')
    })
  })

  describe('remove', () => {
    it('removes a file or an empty directory', async () => {
      const ctx = await setup({ 'a.txt': '', 'dir/': {} })
      await ctx.fs.remove('a.txt')
      await ctx.fs.remove('dir')
      await rejects(ctx.fs.access('a.txt', 'write'), 'NotFound')
      await rejects(ctx.fs.access('dir', 'write'), 'NotFound')
    })

    it('fails on a non-empty directory', async () => {
      const ctx = await setup({ 'dir/a.txt': '' })
      await rejects(ctx.fs.remove('dir'), 'DirectoryNotEmpty')
      await ctx.fs.access('dir/a.txt', 'write')
    })

    it('requires a directory for a trailing separator', async () => {
      const ctx = await setup({ 'a.txt': '' })
      await rejects(ctx.fs.remove('a.txt/'), 'NotADirectory')
      await ctx.fs.access('a.txt', 'write')
    })

    it('fails on a missing location unless forced', async () => {
      const ctx = await setup()
      await rejects(ctx.fs.remove('missing.txt'), 'NotFound')
      await ctx.fs.remove('missing.txt', { force: true })
    })
  })

  describe('location', () => {
    it('keeps the entries of each root apart', async () => {
      const ctx = await setup({ 'a.txt': 'app', 'memory://other/a.txt': 'other' })
      expect(await ctx.fs.file('memory:///a.txt').text()).to.equal('app')
      expect(await ctx.fs.file('memory://other/a.txt').text()).to.equal('other')
    })

    it('names an entry by its decoded path', async () => {
      const ctx = await setup({ 'a b/c%23d.txt': 'foo' })
      expect(await ctx.fs.file('memory:///a%20b/c%23d.txt').text()).to.equal('foo')
      expect(await ctx.fs.file('memory:///a%20b//c%23d.txt').text()).to.equal('foo')
      await ctx.fs.file('memory:///%41.txt').write('bar')
      expect(await ctx.fs.file('memory:///A.txt').text()).to.equal('bar')
    })

    it('rejects a location without a hierarchical path, or with a query, a fragment or an encoded separator', async () => {
      const ctx = await setup({ 'a/b': 'foo' })
      for (const location of ['memory:a', 'memory:///a/b?x', 'memory:///a/b#x', 'memory:///a%2Fb']) {
        await rejects(ctx.fs.file(location).text(), 'InvalidPath')
      }
      expect(() => ctx.fs.watch('memory:a')).to.throw(FsError).with.property('code', 'InvalidPath')
    })
  })

  describe('watch', () => {
    function watch(ctx: Context, path: string, options?: WatchOptions) {
      const seen: string[] = []
      ctx.fs.watch(path, options).on('change', (url) => { seen.push(url.href) })
      return seen
    }

    it('reports each write to a watched file when it completes', async () => {
      const ctx = await setup({ 'a.txt': '' })
      const seen = watch(ctx, 'a.txt')
      await ctx.fs.file('a.txt').write('foo')
      await ctx.fs.file('b.txt').write('foo')
      expect(seen).to.deep.equal(['memory:///a.txt'])
    })

    it('reports a file created or replaced through a rename at a watched location', async () => {
      const ctx = await setup()
      const seen = watch(ctx, 'a.txt')
      await ctx.fs.file('a.txt.tmp').write('foo')
      await ctx.fs.rename('a.txt.tmp', 'a.txt')
      await ctx.fs.file('a.txt.tmp').write('bar')
      await ctx.fs.rename('a.txt.tmp', 'a.txt')
      expect(seen).to.deep.equal(['memory:///a.txt', 'memory:///a.txt'])
    })

    it('reports the files below a watched directory, also those moved into it', async () => {
      const ctx = await setup({ 'dir/nested/': {}, 'src/x/a.txt': '' })
      const seen = watch(ctx, 'dir/')
      await ctx.fs.file('dir/nested/b.txt').write('foo')
      await ctx.fs.rename('src', 'dir/src')
      expect(seen).to.deep.equal(['memory:///dir/nested/b.txt', 'memory:///dir/src/x/a.txt'])
    })

    it('reports the location of a file whose name the URL parser would change', async () => {
      const ctx = await setup()
      const seen = watch(ctx, '.')
      const names = ['a%23b%3Fc%25d.txt', 'a%20', '%20a', 'a%09b', 'a%0Ab']
      for (const name of names) await ctx.fs.file(name).write(name)
      expect(seen).to.deep.equal(names.map(name => `memory:///${name}`))
      for (const [index, url] of seen.entries()) {
        expect(await ctx.fs.file(new URL(url)).text()).to.equal(names[index])
      }
    })

    it('applies `filter` to the entries below a watched directory and their ancestors', async () => {
      const ctx = await setup({ 'dir/lib/': {}, 'dir/src/': {} })
      const tested: [string, boolean][] = []
      const seen = watch(ctx, 'dir', {
        filter: (path, isDirectory) => {
          tested.push([path, isDirectory])
          return path !== 'lib'
        },
      })
      await ctx.fs.file('dir/lib/a.txt').write('')
      await ctx.fs.file('dir/src/a.txt').write('')
      expect(seen).to.deep.equal(['memory:///dir/src/a.txt'])
      expect(tested).to.deep.include.members([['lib', true], ['src', true], ['src/a.txt', false]])
    })

    it('selects the files by glob patterns', async () => {
      const ctx = await setup({ 'dir/src/': {}, 'dir/lib/': {} })
      const seen = watch(ctx, 'dir', { filter: ['src/**/*.ts', '!src/**/*.spec.ts'] })
      for (const name of ['src/a.ts', 'src/a.spec.ts', 'lib/b.ts']) {
        await ctx.fs.file(`dir/${name}`).write('')
      }
      expect(seen).to.deep.equal(['memory:///dir/src/a.ts'])
    })

    it('does not apply `filter` to a watched file', async () => {
      const ctx = await setup()
      const seen = watch(ctx, 'a.txt', { filter: () => false })
      await ctx.fs.file('a.txt').write('')
      expect(seen).to.deep.equal(['memory:///a.txt'])
    })

    it('reports `ready`, and nothing once disposed', async () => {
      const ctx = await setup()
      const watcher = ctx.fs.watch('a.txt')
      const seen: string[] = []
      watcher.on('change', (url) => { seen.push(url.href) })
      await new Promise<void>(resolve => watcher.on('ready', resolve))
      await watcher.dispose()
      await ctx.fs.file('a.txt').write('')
      expect(seen).to.deep.equal([])
    })
  })
})
