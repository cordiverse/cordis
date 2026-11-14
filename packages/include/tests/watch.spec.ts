import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/loader'
import Fs, { FsError } from '@cordisjs/fs'
import NodeFs from '@cordisjs/fs-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as yaml from 'yaml'
import Include from '../src/index.ts'
import { fixture, component } from './utils.ts'

// records the watches instead of starting them
class FakeFs extends Fs {
  static paths: string[] = []
  /** The last listener handed to `watch`, so a test can drive one event itself. */
  static onChange: (() => any) | undefined

  // #292 made every read go through `fs.file(...)`, which routes to a mounted
  // provider. This fake has none, so it answers the read itself.
  file(url: URL): any {
    const path = fileURLToPath(url)
    return {
      text: () => readFile(path, 'utf8').catch((error) => {
        throw error.code === 'ENOENT' ? new FsError('NotFound', url, error.message) : error
      }),
    }
  }

  watch(url: URL): any {
    FakeFs.paths.push(fileURLToPath(url))
    return {
      on: (_event: string, callback: () => any) => {
        FakeFs.onChange = callback
        return () => {}
      },
    }
  }
}

describe('Include watch', () => {
  let fiber: Fiber | undefined
  const filename = fixture('watch.yml')

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
    FakeFs.paths = []
    await rm(filename, { force: true })
  })

  async function setup(config: any = {}) {
    await writeFile(filename, '[]\n')
    const ctx = new Context()
    await ctx.use(FakeFs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, { baseUrl: import.meta.url })
    const id = await ctx.loader.create({
      name: '@cordisjs/include',
      config: { path: './fixtures/watch.yml', ...config },
    })
    await ctx.loader.store[id]!.innerFiber!.await()
    return { ctx, id }
  }

  it('does not watch the config file by default', async () => {
    await setup()
    expect(FakeFs.paths).to.deep.equal([])
  })

  it('watches the config file with `watch: true`', async () => {
    await setup({ watch: true })
    expect(FakeFs.paths).to.deep.equal([filename])
  })

  it('restarts when `watch` is toggled', async () => {
    const { ctx, id } = await setup()
    await ctx.loader.update(id, { config: { path: './fixtures/watch.yml', watch: true } })
    await ctx.loader.store[id]!.innerFiber!.await()
    expect(FakeFs.paths).to.deep.equal([filename])
  })
})

describe('Include watch with fs', () => {
  let fiber: Fiber | undefined
  const filename = fixture('watch-fs.yml')

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
    await rm(filename, { force: true })
  })

  it('keeps watching the file across its own rename-based writes', async () => {
    await writeFile(filename, yaml.stringify([component('a', 0)]))
    const ctx = new Context()
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, { baseUrl: import.meta.url })
    const id = await ctx.loader.create({
      name: '@cordisjs/include',
      config: { path: './fixtures/watch-fs.yml', watch: true },
    })
    await ctx.loader.store[id]!.innerFiber!.await()
    const include = ctx.loader.store[id]!.subtree as Include
    const refresh = vi.spyOn(include, 'refresh')

    // two runtime writes, each replacing the file through a rename
    for (const value of [1, 2]) {
      await ctx.loader.update(`${id}:a`, { config: { tag: 'a', value } })
      await include.refresh()
    }
    await vi.waitFor(async () => expect(await readFile(filename, 'utf8')).toContain('value: 2'))
    await new Promise(r => setTimeout(r, 500))

    // an external edit still reaches the tree through the watch; some
    // platforms drop single events, so the file is rewritten until one is seen
    const external = yaml.stringify([component('a', 3)])
    await vi.waitFor(async () => {
      await writeFile(filename, external)
      expect(ctx.bail('test/config', 'a')?.value).toBe(3)
    }, { timeout: 5000, interval: 200 })

    // and the writes of the include itself do not start a feedback loop. The number of
    // reads is left unpinned: an event costs two now, some platforms drop single events,
    // and one rewrite can arrive as two, so any ceiling here measures how the platform
    // delivers events. What a loop does instead is keep going when nothing outside changes.
    await new Promise(r => setTimeout(r, 500))
    const quiet = refresh.mock.calls.length
    await new Promise(r => setTimeout(r, 500))
    expect(refresh.mock.calls.length, 'refreshes keep coming while the file stays as it was')
      .toBe(quiet)
    expect(await readFile(filename, 'utf8')).toBe(external)
  }, 15000)

  // No callback after the watch is disposed. The confirm keeps a timer, so a disposal inside
  // the window must not fire it -- and the same device has to fire it when nothing is
  // disposed, or the silence proves nothing. One event is driven by hand so the window is the
  // test's, not the operating system's.
  it('does not re-read after it is disposed mid-window', async () => {
    async function setup() {
      await writeFile(filename, '[]\n')
      const ctx = new Context()
      await ctx.use(FakeFs)
      const fiber = await ctx.use(Loader, { baseUrl: import.meta.url })
      const id = await ctx.loader.create({
        name: '@cordisjs/include',
        config: { path: './fixtures/watch-fs.yml', watch: true },
      })
      const inner = ctx.loader.store[id]!.innerFiber!
      await inner.await()
      const include = ctx.loader.store[id]!.subtree as Include
      const calls: string[] = []
      vi.spyOn(include, 'refresh').mockImplementation((() => {
        calls.push('read')
        return Promise.resolve()
      }) as any)
      return { fiber, inner, calls }
    }

    // control first: without a disposal, the same event reads twice
    const control = await setup()
    FakeFs.onChange!()
    await new Promise(r => setTimeout(r, 200))
    expect(control.calls, 'the device can count two').to.deep.equal(['read', 'read'])
    await control.fiber.dispose()

    // then the disposal: the immediate read has happened, the held one must not
    const held = await setup()
    FakeFs.onChange!()
    await held.inner.dispose()
    await new Promise(r => setTimeout(r, 200))
    expect(held.calls, 'a held re-read fired after disposal').to.deep.equal(['read'])
    await held.fiber.dispose()
  }, 15000)

  // chokidar reports the one `change` for a 10 ms burst before the second write lands, so the
  // read inside the event sees the first content. The confirm read after the window sees the
  // second.
  it('serves the second of two writes 10 ms apart', async () => {
    await writeFile(filename, yaml.stringify([component('a', 0)]))
    const ctx = new Context()
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, { baseUrl: import.meta.url })
    const id = await ctx.loader.create({
      name: '@cordisjs/include',
      config: { path: './fixtures/watch-fs.yml', watch: true },
    })
    await ctx.loader.store[id]!.innerFiber!.await()
    const value = () => ctx.bail('test/config', 'a')?.value

    // some platforms report the first write of a fresh watch late, or not at all
    await vi.waitFor(async () => {
      await writeFile(filename, yaml.stringify([component('a', 1)]))
      expect(value()).toBe(1)
    }, { timeout: 5000, interval: 200 })
    await new Promise(r => setTimeout(r, 300))

    await writeFile(filename, yaml.stringify([component('a', 2)]))
    await new Promise(r => setTimeout(r, 10))
    await writeFile(filename, yaml.stringify([component('a', 3)]))
    await new Promise(r => setTimeout(r, 400))

    expect(value(), 'the second write never reached the tree').toBe(3)
  }, 15000)

  // the confirm runs in a timer, which would drop the promise the listener used to return:
  // a failing re-read has to stay a logged warning rather than an unhandled rejection
  it('logs a re-read that fails', async () => {
    await writeFile(filename, yaml.stringify([component('a', 0)]))
    const ctx = new Context()
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, { baseUrl: import.meta.url })
    const id = await ctx.loader.create({
      name: '@cordisjs/include',
      config: { path: './fixtures/watch-fs.yml', watch: true },
    })
    await ctx.loader.store[id]!.innerFiber!.await()
    const include = ctx.loader.store[id]!.subtree as Include
    const warn = vi.spyOn(ctx.logger, 'warn')
    const failure = new Error('unreadable')
    include.refresh = () => Promise.reject(failure)

    // some platforms report the first write of a fresh watch late, or not at all
    await vi.waitFor(async () => {
      await writeFile(filename, yaml.stringify([component('a', 1)]))
      expect(warn).toHaveBeenCalledWith(failure)
    }, { timeout: 5000, interval: 200 })
  }, 15000)

  // The first read is returned to the emitter, so a consumer that subscribed to the watch's
  // `error` gets the failure, exactly as before this change. Only the held read, which has no
  // caller to return to, takes the logger instead.
  it('reports a failing first read to the watch, not only to the log', async () => {
    await writeFile(filename, yaml.stringify([component('a', 0)]))
    const ctx = new Context()
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, { baseUrl: import.meta.url })
    const watch = ctx.fs.watch.bind(ctx.fs)
    let watcher: ReturnType<typeof ctx.fs.watch> | undefined
    ctx.fs.watch = ((...args: any[]) => (watcher = watch(...args as [string]))) as any
    const id = await ctx.loader.create({
      name: '@cordisjs/include',
      config: { path: './fixtures/watch-fs.yml', watch: true },
    })
    await ctx.loader.store[id]!.innerFiber!.await()
    const include = ctx.loader.store[id]!.subtree as Include
    const heard: unknown[] = []
    watcher!.on('error', (error) => { heard.push(error) })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const failure = new Error('unreadable')
    // only the first read fails, so the held read cannot account for a warning
    let reads = 0
    include.refresh = () => (++reads === 1 ? Promise.reject(failure) : Promise.resolve())

    await vi.waitFor(async () => {
      await writeFile(filename, yaml.stringify([component('a', 1)]))
      expect(heard).to.deep.equal([failure])
    }, { timeout: 5000, interval: 200 })
    await new Promise(r => setTimeout(r, 200))
    expect(warn, 'a routed failure must not also be logged').not.toHaveBeenCalledWith(failure)
  }, 15000)
})
