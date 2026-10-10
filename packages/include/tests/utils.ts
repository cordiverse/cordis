import { Context, Fiber, Message } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { afterEach } from 'vitest'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import Include from '../src'

export const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

export const plugin = (id: string, value: number, extra: any = {}) => ({
  id,
  name: './config-plugin',
  config: { tag: id, value },
  ...extra,
})

export const group = (id: string, config: any[]) => ({
  id,
  name: '@cordisjs/plugin-group',
  group: true,
  config,
})

/**
 * Per-suite harness: `setup` boots a loader with one include over a fresh
 * fixture file; everything it created is disposed and removed after each test.
 */
export function harness() {
  let fiber: Fiber<Context> | undefined
  const files: string[] = []

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
    for (const file of files.splice(0)) {
      await chmod(file, 0o644).catch(() => {})
      await rm(file, { force: true })
    }
  })

  async function setup(name: string, data: any[] | string, config: any = {}) {
    const filename = fixture(name)
    files.push(filename)
    await writeFile(filename, typeof data === 'string' ? data : yaml.dump(data))

    const ctx = new Context()
    const messages: Message[] = []
    ctx.logger.exporter({ export: message => messages.push(message) })
    fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    const id = await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: { path: `./fixtures/${name}`, ...config },
    })
    await ctx.loader.store[id]!.fiber!.await()

    const include = () => ctx.loader.store[id]!.subtree as Include
    // what hmr does on a change event; `refresh` also waits for any write
    const settle = async () => {
      await include().refresh()
      await ctx.loader.await()
    }
    await settle()

    return {
      ctx,
      id,
      filename,
      include,
      settle,
      messages,
      files,
      dispose: () => fiber!.dispose(),
      text: () => readFile(filename, 'utf8'),
      read: async () => yaml.load(await readFile(filename, 'utf8')) as any[],
      config: (tag: string) => ctx.bail('test/config', tag),
      logs: (type: Message['type']) => messages.filter(m => m.type === type).map(m => m.args.join(' ')),
      update: (local: string, options: any) => ctx.loader.update(`${id}:${local}`, options),
    }
  }

  return { setup }
}
