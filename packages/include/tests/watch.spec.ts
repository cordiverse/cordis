import { Context, Fiber, Service } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Fs from '@cordisjs/plugin-fs-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import * as yaml from 'yaml'
import Include from '../src/index.ts'
import { fixture, plugin } from './utils.ts'

class FakeFs extends Service {
  static paths: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  watch(path: string) {
    FakeFs.paths.push(path)
    return () => {}
  }
}

describe('Include watch', () => {
  let fiber: Fiber<Context> | undefined
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
    await ctx.plugin(FakeFs)
    fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    const id = await ctx.loader.create({
      name: '@cordisjs/plugin-include',
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
  let fiber: Fiber<Context> | undefined
  const filename = fixture('watch-fs.yml')

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
    await rm(filename, { force: true })
  })

  it('keeps watching the file across its own rename-based writes', async () => {
    await writeFile(filename, yaml.stringify([plugin('a', 0)]))
    const ctx = new Context()
    await ctx.plugin(Fs)
    fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    const id = await ctx.loader.create({
      name: '@cordisjs/plugin-include',
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
    const settled = refresh.mock.calls.length

    // an external edit still reaches the tree through the watch; some
    // platforms drop single events, so the file is rewritten until one is seen
    const external = yaml.stringify([plugin('a', 3)])
    await vi.waitFor(async () => {
      await writeFile(filename, external)
      expect(ctx.bail('test/config', 'a')?.value).toBe(3)
    }, { timeout: 5000, interval: 200 })

    // and the writes of the include itself do not start a feedback loop
    await new Promise(r => setTimeout(r, 500))
    expect(refresh.mock.calls.length - settled).toBeLessThanOrEqual(3)
    expect(await readFile(filename, 'utf8')).toBe(external)
  }, 15000)
})
