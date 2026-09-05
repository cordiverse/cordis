import { Context, Fiber, Message } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import LoggerConsole from '@cordisjs/plugin-logger-console'
import { expect, describe, it, afterEach } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import Include from '../src'

function waitFor(condFn: () => any, timeout = 5000, interval = 20): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const check = setInterval(() => {
      if (condFn()) { clearInterval(check); resolve() }
    }, interval)
    setTimeout(() => { clearInterval(check); reject(new Error('waitFor timed out')) }, timeout)
  })
}

const INNER = '- id: inner\n  name: ./test-plugin\n'
const INNER_EXTRA = '- id: inner\n  name: ./test-plugin\n- id: extra\n  name: ./extra-plugin\n'
const NOT_AN_ARRAY = 'inner: ./test-plugin\n'
const UNPARSABLE = '- {\n'

interface Harness {
  ctx: Context
  filename: string
  include(): Include
  warnings(): string[]
}

describe('Include reload', () => {
  let ctx: Context | undefined
  let fiber: Fiber<Context> | undefined
  let filename: string | undefined

  afterEach(async () => {
    await fiber?.dispose()
    if (filename) await rm(filename, { force: true })
    ctx = fiber = filename = undefined
  })

  async function setup(name: string, content: string, config: any = {}): Promise<Harness> {
    filename = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
    await writeFile(filename, content)
    ctx = new Context()
    await ctx.plugin(LoggerConsole)
    const messages: Message[] = []
    ctx.logger.exporter({ export: message => messages.push(message) })
    fiber = await ctx.plugin(Loader, {
      baseUrl: import.meta.url,
    })
    const id = await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: {
        path: `./fixtures/${name}`,
        ...config,
      },
    })
    return {
      ctx: ctx!,
      filename: filename!,
      include: () => ctx!.loader.store[id]!.subtree as Include,
      warnings: () => messages.filter(m => m.type === 'warn').map(m => m.args.join(' ')),
    }
  }

  it('re-applies patches on every reload', async () => {
    const app = await setup('tmp-reload-patches.yml', INNER, {
      patches: [
        { id: 'inner', disabled: true },
      ],
    })
    await new Promise(r => setTimeout(r, 500))
    expect(app.ctx.bail('test/get-value')).to.be.undefined

    await writeFile(app.filename, INNER_EXTRA)
    await app.include().refresh()

    // the new entry loads, and the overlay is applied to the new parse too:
    // a reload must not silently drop the patch list
    await waitFor(() => app.ctx.bail('test/get-extra'))
    expect(app.ctx.bail('test/get-value')).to.be.undefined
  }, 10000)

  it('reverts an entry when its patch is removed', async () => {
    const app = await setup('tmp-reload-revert.yml', INNER, {
      patches: [
        { id: 'inner', disabled: true },
      ],
    })
    await new Promise(r => setTimeout(r, 500))
    expect(app.ctx.bail('test/get-value')).to.be.undefined

    // patches apply to a clone: had the overlay been written into the cached
    // parse, dropping it here could never bring the entry back
    await app.ctx.loader.update(app.include().ctx.fiber.entry!.id, {
      config: {
        path: './fixtures/tmp-reload-revert.yml',
      },
    })

    await waitFor(() => app.ctx.bail('test/get-value'))
    expect(app.ctx.bail('test/get-value')).to.equal('default')
  }, 10000)

  it('keeps the tree reloadable after an invalid file', async () => {
    const app = await setup('tmp-reload-invalid.yml', INNER)
    await waitFor(() => app.ctx.bail('test/get-value'))

    await writeFile(app.filename, NOT_AN_ARRAY)
    // refresh never rejects: the include reports the bad file itself so that
    // hmr needs no error handling
    await app.include().refresh()
    expect(app.warnings().some(line => line.includes('failed to validate config file'))).to.be.true
    expect(app.ctx.bail('test/get-value')).to.equal('default')

    // the failed candidate never committed, so the next good file still reads
    // as a change and reconciles against an intact tree
    await writeFile(app.filename, INNER_EXTRA)
    await app.include().refresh()
    await waitFor(() => app.ctx.bail('test/get-extra'))
    expect(app.ctx.bail('test/get-value')).to.equal('default')
  }, 10000)

  it('never overwrites an existing but unparsable file with initial', async () => {
    const app = await setup('tmp-reload-initial.yml', UNPARSABLE, {
      initial: [
        { id: 'extra', name: './extra-plugin' },
      ],
    })
    await new Promise(r => setTimeout(r, 500))

    // only ENOENT falls back to `initial`; a file we failed to parse belongs to
    // the user and must survive
    expect(await readFile(app.filename, 'utf8')).to.equal(UNPARSABLE)
    expect(app.ctx.bail('test/get-extra')).to.be.undefined
  }, 10000)
})
