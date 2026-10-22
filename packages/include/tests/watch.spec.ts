import { Context, Fiber, Service } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import { fixture } from './utils.ts'

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
    await ctx.loader.store[id]!.fiber!.await()
    return { ctx, id }
  }

  it('watches the config file by default', async () => {
    await setup()
    expect(FakeFs.paths).to.deep.equal([filename])
  })

  it('does not watch the config file with `watch: false`', async () => {
    await setup({ watch: false })
    expect(FakeFs.paths).to.deep.equal([])
  })

  it('restarts when `watch` is toggled', async () => {
    const { ctx, id } = await setup({ watch: false })
    await ctx.loader.update(id, { config: { path: './fixtures/watch.yml', watch: true } })
    await ctx.loader.store[id]!.fiber!.await()
    expect(FakeFs.paths).to.deep.equal([filename])
  })
})
