import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '../src'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

describe('Include initial config', () => {
  let ctx: Context
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cordis-include-'))
    ctx = new Context()
    await ctx.plugin(Loader)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('creates a missing config before startup completes', async () => {
    const filename = join(tempDir, 'cordis.json')
    const initial = [{ id: 'foo', name: 'foo', disabled: true }]

    await ctx.plugin(Include, {
      path: pathToFileURL(filename).href,
      initial,
    })

    expect(JSON.parse(await readFile(filename, 'utf8'))).to.deep.equal(initial)
  })

  it('does not replace a malformed config with the initial value', async () => {
    const filename = join(tempDir, 'cordis.json')
    const malformed = '{"plugins": ['
    await writeFile(filename, malformed)

    await expect(ctx.plugin(Include, {
      path: pathToFileURL(filename).href,
      initial: [],
    })).rejects.toThrow()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await readFile(filename, 'utf8')).to.equal(malformed)
  })
})
