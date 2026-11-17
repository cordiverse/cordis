import { Context, Fiber, Message } from 'cordis'
import Loader from '@cordisjs/loader'
import Fs from '@cordisjs/fs'
import MemoryFs from '@cordisjs/fs-memory'
import { afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import * as yaml from 'yaml'
import Include from '../src/index.ts'

/**
 * The directory of the config files and of the components they load. The
 * config files exist only in memory, at a mount of this URL; the components
 * are imported from disk.
 */
export const fixtures = new URL('./fixtures/', import.meta.url)

export const fixture = (name: string) => fileURLToPath(new URL(name, fixtures))

export const component = (id: string, value: number, extra: any = {}) => ({
  id,
  name: './config-component',
  config: { tag: id, value },
  ...extra,
})

export const group = (id: string, config: any[]) => ({
  id,
  name: '@cordisjs/group',
  group: true,
  config,
})

export interface Options {
  /** other files that exist before the include starts, by their names in `fixtures` */
  files?: MemoryFs.Tree
  Provider?: typeof MemoryFs
}

/**
 * Per-suite harness: `setup` boots a loader with one include over a config
 * file in memory; everything it created is disposed after each test.
 * `defaults` applies to every `setup` of the suite.
 */
export function harness(defaults: Options = {}) {
  let fiber: Fiber | undefined

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
  })

  async function setup(name: string, data: any[] | string, config: any = {}, options: Options = {}) {
    const { files, Provider = MemoryFs } = { ...defaults, ...options }
    const ctx = new Context()
    const messages: Message[] = []
    ctx.logger.exporter({ export: message => messages.push(message) })
    await ctx.use(Fs, { baseUrl: new URL('.', import.meta.url).href })
    await ctx.use(Provider, {
      mount: fixtures.href,
      files: { ...files, [name]: typeof data === 'string' ? data : yaml.stringify(data) },
    })
    fiber = await ctx.use(Loader)
    const id = await ctx.loader.create({
      name: '@cordisjs/include',
      config: { path: `./fixtures/${name}`, ...config },
    })
    await ctx.loader.await()

    const include = () => ctx.loader.store[id]!.subtree as Include
    // what `ctx.fs.watch()` triggers on a change; `refresh` also waits for any write
    const settle = async () => {
      await include().refresh()
      await ctx.loader.await()
    }
    await settle()

    // a file of `fixtures`, the config file of the include by default
    const file = (path = name) => ctx.fs.file(new URL(path, fixtures))
    const text = (path?: string) => file(path).text()

    return {
      ctx,
      id,
      url: new URL(name, fixtures),
      filename: fixture(name),
      include,
      settle,
      messages,
      dispose: () => fiber!.dispose(),
      text,
      read: async (path?: string) => yaml.parse(await text(path)) as any[],
      write: (content: string, path?: string) => file(path).write(content),
      config: (tag: string) => ctx.bail('test/config', tag),
      logs: (type: Message['type']) => messages.filter(m => m.type === type).map(m => m.args.join(' ')),
      update: (local: string, options: any) => ctx.loader.update(`${id}:${local}`, options),
    }
  }

  return { setup }
}
