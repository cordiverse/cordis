import { Context, Fiber, FiberState } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Fs, { FsError, WatchOptions } from '@cordisjs/fs'
import { conformance } from '@cordisjs/fs-conformance'
import MemoryFs from '../src/index.ts'

conformance('MemoryFs', {
  async setup(ctx) {
    await ctx.use(MemoryFs)
    return new URL('memory://conformance/')
  },
  capabilities: { exclusive: true, atomic: true },
})

// a provider that declares only `exclusive`, on which `@cordisjs/fs` composes ranges and atomic writes
class PlainFs extends MemoryFs {
  readonly capabilities = { exclusive: true }
}

conformance('MemoryFs with composed ranges and atomic writes', {
  async setup(ctx) {
    await ctx.use(PlainFs)
    return new URL('memory://conformance/')
  },
  capabilities: { exclusive: true, atomic: true },
})

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
    fibers.push(await ctx.use(Fs, { baseUrl: 'memory:///' }))
    return ctx
  }

  async function setup(files: MemoryFs.Tree = {}) {
    const ctx = await context()
    fibers.push(await ctx.use(MemoryFs, { files }))
    return ctx
  }

  // the state of `MemoryFs` once it has started or failed
  async function start(ctx: Context, config: MemoryFs.Config) {
    const fiber = ctx.use(MemoryFs, config)
    fibers.push(fiber)
    await fiber.await().catch(() => {})
    return fiber.state
  }

  it('checks exclusive atomic creation when the write commits', async () => {
    const ctx = await setup({ 'src': 'winner' })
    const dest = ctx.fs.file('memory:///dest')
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    const options = { atomic: true, exclusive: true }
    const pending = dest.write(body, options)
    controller.enqueue(new Uint8Array([1]))
    expect(await ctx.fs.exists(dest.url)).to.equal(false)
    await ctx.fs.copy('memory:///src', dest.url, options)
    controller.close()
    await rejects(pending, 'AlreadyExists')
    expect(await dest.text()).to.equal('winner')
  })

  describe('mount', () => {
    it('mounts at `memory:` by default, or at `config.mount`', async () => {
      const ctx = await setup({ 'a.txt': 'foo' })
      fibers.push(await ctx.use(MemoryFs, { mount: 'other:', files: { 'a.txt': 'bar' } }))
      fibers.push(await ctx.use(MemoryFs, { mount: 'memory://data', files: { 'a.txt': 'baz' } }))
      expect(await ctx.fs.file('memory:///a.txt').text()).to.equal('foo')
      expect(await ctx.fs.file('other:///a.txt').text()).to.equal('bar')
      expect(await ctx.fs.file('memory://data/a.txt').text()).to.equal('baz')
    })

    it('takes absolute keys for a mount at a scheme whose URLs require a host', async () => {
      const ctx = await setup()
      expect(await start(ctx, { mount: 'https:' })).to.equal(FiberState.ACTIVE)
      fibers.push(await ctx.use(MemoryFs, { mount: 'wss:', files: { 'wss://app/a.txt': 'foo' } }))
      expect(await ctx.fs.file('wss://app/a.txt').text()).to.equal('foo')
    })

    it('takes absolute keys of any scheme for a mount at the empty string', async () => {
      const ctx = await context()
      fibers.push(await ctx.use(MemoryFs, { mount: '', files: { 'https://app/a.txt': 'foo', 'file:///b.txt': 'bar' } }))
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
  })

  describe('write', () => {
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

  describe('stat', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('reports the time of the last write of a file, and of the last change of the entries of a directory', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(1000)
      const ctx = await setup({ 'dir/a.txt': 'foo' })
      const mtime = async (path: string) => (await ctx.fs.stat(path)).mtime.getTime()

      vi.setSystemTime(2000)
      await ctx.fs.file('dir/a.txt').write('bar')
      expect(await mtime('dir/a.txt')).to.equal(2000)
      expect(await mtime('dir')).to.equal(1000)

      vi.setSystemTime(3000)
      await ctx.fs.file('dir/b.txt').write('')
      expect(await mtime('dir')).to.equal(3000)

      vi.setSystemTime(4000)
      await ctx.fs.remove('dir/b.txt')
      expect(await mtime('dir')).to.equal(4000)
      expect(await mtime('dir/a.txt')).to.equal(2000)

      vi.setSystemTime(5000)
      await ctx.fs.copy('dir/a.txt', 'dir/c.txt')
      expect(await mtime('dir/c.txt')).to.equal(5000)
      expect(await mtime('dir')).to.equal(5000)
    })
  })

  describe('copy', () => {
    it('creates the file once for two concurrent copies with `exclusive: true`', async () => {
      const ctx = await setup({ 'a.txt': 'foo', 'b.txt': 'bar' })
      const results = await Promise.allSettled([
        ctx.fs.copy('a.txt', 'c.txt', { exclusive: true }),
        ctx.fs.copy('b.txt', 'c.txt', { exclusive: true }),
      ])
      const created = results.findIndex(result => result.status === 'fulfilled')
      expect(results.filter(result => result.status === 'fulfilled')).to.have.length(1)
      expect((results[1 - created] as PromiseRejectedResult).reason).to.have.property('code', 'AlreadyExists')
      expect(await ctx.fs.file('c.txt').text()).to.equal(['foo', 'bar'][created])
    })

    it('copies between two mounts through their content', async () => {
      const copies: string[] = []
      class RecordingFs extends MemoryFs {
        async copy(src: URL, dest: URL, options: { exclusive: boolean }) {
          copies.push(src.href)
          return super.copy(src, dest, options)
        }
      }
      const ctx = await context()
      fibers.push(await ctx.use(RecordingFs, { mount: 'memory://one/', files: { 'src/a.txt': 'foo', 'src/sub/b.txt': 'bar' } }))
      fibers.push(await ctx.use(RecordingFs, { mount: 'memory://two/' }))

      await ctx.fs.copy('memory://one/src', 'memory://two/dest', { recursive: true })
      expect(await ctx.fs.file('memory://two/dest/a.txt').text()).to.equal('foo')
      expect(await ctx.fs.file('memory://two/dest/sub/b.txt').text()).to.equal('bar')
      expect(copies).to.deep.equal([])
    })
  })

  describe('location', () => {
    it('keeps the entries of each root apart', async () => {
      const ctx = await setup({ 'a.txt': 'app', 'memory://other/a.txt': 'other' })
      expect(await ctx.fs.file('memory:///a.txt').text()).to.equal('app')
      expect(await ctx.fs.file('memory://other/a.txt').text()).to.equal('other')
    })

    it('names an entry by its decoded path', async () => {
      const ctx = await setup({ 'a b/c#d.txt': 'foo' })
      expect(await ctx.fs.file('memory:///a%20b/c%23d.txt').text()).to.equal('foo')
      expect(await ctx.fs.file('memory:///a%20b//c%23d.txt').text()).to.equal('foo')
      await ctx.fs.file('memory:///%41.txt').write('bar')
      expect(await ctx.fs.file('memory:///A.txt').text()).to.equal('bar')
    })

    it('rejects a location without a hierarchical path', async () => {
      const ctx = await setup({ 'a/b': 'foo' })
      await rejects(ctx.fs.file('memory:a').text(), 'InvalidPath')
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
      const names = ['a#b?c%d.txt', 'a ', ' a', 'a\tb', 'a\nb', 'a\\b']
      for (const name of names) await ctx.fs.file([name]).write(name)
      expect(seen).to.deep.equal(['a%23b%3Fc%25d.txt', 'a%20', '%20a', 'a%09b', 'a%0Ab', 'a%5Cb'].map(name => `memory:///${name}`))
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
