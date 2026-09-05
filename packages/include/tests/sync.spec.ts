import { Context, Fiber, Message } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { expect, describe, it, afterEach } from 'vitest'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import Include from '../src'
import { applied } from './fixtures/config-plugin'

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

const plugin = (id: string, value: number, extra: any = {}) => ({
  id,
  name: './config-plugin',
  config: { tag: id, value },
  ...extra,
})

const group = (id: string, config: any[]) => ({
  id,
  name: '@cordisjs/plugin-group',
  group: true,
  config,
})

describe('Include sync', () => {
  let ctx: Context | undefined
  let fiber: Fiber<Context> | undefined
  const files: string[] = []

  afterEach(async () => {
    await fiber?.dispose()
    ctx = fiber = undefined
    for (const file of files.splice(0)) {
      await chmod(file, 0o644).catch(() => {})
      await rm(file, { force: true })
    }
  })

  async function setup(name: string, data: any[] | string, config: any = {}) {
    const filename = fixture(name)
    files.push(filename)
    await writeFile(filename, typeof data === 'string' ? data : yaml.dump(data))

    ctx = new Context()
    const messages: Message[] = []
    ctx.logger.exporter({ export: message => messages.push(message) })
    fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    const id = await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: { path: `./fixtures/${name}`, ...config },
    })
    await ctx.loader.store[id]!.fiber!.await()

    const include = () => ctx!.loader.store[id]!.subtree as Include
    // what hmr does on a change event; `refresh` also waits for any write
    const settle = async () => {
      await include().refresh()
      await ctx!.loader.await()
    }
    await settle()

    return {
      ctx: ctx!,
      id,
      filename,
      include,
      settle,
      messages,
      text: () => readFile(filename, 'utf8'),
      read: async () => yaml.load(await readFile(filename, 'utf8')) as any[],
      config: (tag: string) => ctx!.bail('test/config', tag),
      logs: (type: Message['type']) => messages.filter(m => m.type === type).map(m => m.args.join(' ')),
      update: (local: string, options: any) => ctx!.loader.update(`${id}:${local}`, options),
    }
  }

  it('coalesces consecutive writes into the latest state', async () => {
    const app = await setup('tmp-sync-coalesce.yml', [plugin('a', 1)])

    for (const value of [2, 3, 4]) {
      await app.update('a', { config: { tag: 'a', value } })
    }
    await app.settle()

    expect(app.config('a').value).toBe(4)
    expect((await app.read())[0].config.value).toBe(4)
    expect(app.logs('error')).toEqual([])
  }, 10000)

  it('keeps file and tree consistent when a refresh lands inside a write', async () => {
    const app = await setup('tmp-sync-window.yml', [plugin('a', 1)])

    const update = app.update('a', { config: { tag: 'a', value: 2 } })
    const refresh = app.include().refresh()
    await Promise.all([update, refresh])
    await app.settle()

    expect(app.config('a').value).toBe(2)
    expect((await app.read())[0].config.value).toBe(2)
  }, 10000)

  it('does not write back when the file removes an entry', async () => {
    const before = '# keep me\n' + yaml.dump([plugin('a', 1), plugin('b', 1)])
    const app = await setup('tmp-sync-remove.yml', before)
    expect(app.config('b')).toBeTruthy()

    const after = '# keep me\n' + yaml.dump([plugin('a', 1)])
    await writeFile(app.filename, after)
    await app.settle()

    expect(app.config('b')).toBeUndefined()
    expect(await app.text()).toBe(after)
    expect(app.logs('error')).toEqual([])
  }, 10000)

  it('does not write back when the file disables an entry', async () => {
    const app = await setup('tmp-sync-disable.yml', '# keep me\n' + yaml.dump([plugin('a', 1)]))

    const after = '# keep me\n' + yaml.dump([plugin('a', 1, { disabled: true })])
    await writeFile(app.filename, after)
    await app.settle()

    expect(app.config('a')).toBeUndefined()
    expect(await app.text()).toBe(after)
  }, 10000)

  it('merges a file edit and a runtime edit on different entries', async () => {
    const app = await setup('tmp-sync-merge.yml', [plugin('a', 1), plugin('b', 1)])

    // the file changes under us without any watcher telling us
    await writeFile(app.filename, yaml.dump([plugin('a', 1), plugin('b', 2)]))
    await app.update('a', { config: { tag: 'a', value: 2 } })
    await app.settle()

    expect(app.config('a').value).toBe(2)
    expect(app.config('b').value).toBe(2)
    const [a, b] = await app.read()
    expect(a.config.value).toBe(2)
    expect(b.config.value).toBe(2)
    expect(app.logs('error')).toEqual([])
  }, 10000)

  // The webui saves entry A while the editor saves entry B and the watcher
  // fires: whichever side gets to the include first, both edits survive.
  for (const order of ['refresh first', 'update first'] as const) {
    it(`merges a watcher-driven file edit racing a runtime edit (${order})`, async () => {
      const app = await setup(`tmp-sync-race-${order.replace(' ', '-')}.yml`, [plugin('a', 1), plugin('b', 1)])

      await writeFile(app.filename, yaml.dump([plugin('a', 1), plugin('b', 2)]))
      const tasks: Promise<unknown>[] = []
      if (order === 'refresh first') tasks.push(app.include().refresh())
      tasks.push(app.update('a', { config: { tag: 'a', value: 2 } }))
      if (order === 'update first') tasks.push(app.include().refresh())
      await Promise.all(tasks)
      await app.settle()

      expect(app.config('a').value).toBe(2)
      expect(app.config('b').value).toBe(2)
      const [a, b] = await app.read()
      expect(a.config.value).toBe(2)
      expect(b.config.value).toBe(2)
      expect(app.logs('error')).toEqual([])
    }, 10000)
  }

  it('lets the file win a conflict on the same entry and reports it', async () => {
    const app = await setup('tmp-sync-conflict.yml', [plugin('a', 1)])

    await writeFile(app.filename, yaml.dump([plugin('a', 3)]))
    await app.update('a', { config: { tag: 'a', value: 2 } })
    await app.settle()

    expect(app.config('a').value).toBe(3)
    expect((await app.read())[0].config.value).toBe(3)
    const errors = app.logs('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/conflict/)
    expect(errors[0]).toMatch(/config/)
  }, 10000)

  it('combines a move in the file with an edit at runtime', async () => {
    const app = await setup('tmp-sync-move.yml', [plugin('a', 1), group('g', [])])

    await writeFile(app.filename, yaml.dump([group('g', [plugin('a', 1)])]))
    await app.update('a', { config: { tag: 'a', value: 2 } })
    await app.settle()

    const include = app.include()
    expect(include.store['a']!.parent).toBe(include.store['g']!.subgroup)
    expect(app.config('a').value).toBe(2)
    const [g] = await app.read()
    expect(g.id).toBe('g')
    expect(g.config).toEqual([plugin('a', 2)])
    expect(app.logs('error')).toEqual([])
  }, 10000)

  it('never writes over a file it cannot parse', async () => {
    const app = await setup('tmp-sync-broken.yml', [plugin('a', 1)])

    await writeFile(app.filename, '- {\n')
    await app.update('a', { config: { tag: 'a', value: 2 } })
    await app.include().refresh()
    expect(app.logs('warn').some(line => line.includes('failed to parse'))).toBe(true)
    expect(await app.text()).toBe('- {\n')
    expect(app.config('a').value).toBe(2)

    // once the file is valid again the pending change goes out with the merge
    await writeFile(app.filename, yaml.dump([plugin('a', 1), plugin('b', 1)]))
    await app.settle()
    const [a, b] = await app.read()
    expect(a.config.value).toBe(2)
    expect(b.config.value).toBe(1)
    expect(app.config('b').value).toBe(1)
  }, 10000)

  it('routes changes to patch-owned keys into the parent config', async () => {
    const inner = fixture('tmp-sync-inner-patch.yml')
    files.push(inner)
    const innerText = yaml.dump([plugin('a', 1)])
    await writeFile(inner, innerText)
    const app = await setup('tmp-sync-outer-patch.yml', [{
      id: 'inc',
      name: '@cordisjs/plugin-include',
      config: {
        path: './tmp-sync-inner-patch.yml',
        patches: [{ id: 'a', disabled: true }],
      },
    }])
    const innerInclude = () => app.include().store['inc']!.subtree as Include
    await innerInclude().refresh()
    expect(app.config('a')).toBeUndefined()

    await app.update('inc:a', { disabled: false })
    await innerInclude().refresh()
    await app.settle()

    expect(app.config('a').value).toBe(1)
    expect(await readFile(inner, 'utf8')).toBe(innerText)
    const [entry] = await app.read()
    expect(entry.config.patches).toEqual([{ id: 'a', disabled: false }])
    expect(app.logs('error')).toEqual([])
  }, 10000)

  it('routes changes to inserted entries into their patch', async () => {
    const inner = fixture('tmp-sync-inner-insert.yml')
    files.push(inner)
    const innerText = yaml.dump([plugin('a', 1)])
    await writeFile(inner, innerText)
    const app = await setup('tmp-sync-outer-insert.yml', [{
      id: 'inc',
      name: '@cordisjs/plugin-include',
      config: {
        path: './tmp-sync-inner-insert.yml',
        patches: [{ insert: [plugin('x', 1)] }],
      },
    }])
    const innerInclude = () => app.include().store['inc']!.subtree as Include
    await innerInclude().refresh()
    await app.ctx.loader.await()
    expect(app.config('x').value).toBe(1)

    await app.update('inc:x', { config: { tag: 'x', value: 2 } })
    await innerInclude().refresh()
    await app.settle()

    expect(app.config('x').value).toBe(2)
    expect(await readFile(inner, 'utf8')).toBe(innerText)
    const [entry] = await app.read()
    expect(entry.config.patches).toEqual([{ insert: [plugin('x', 2)] }])
  }, 10000)

  it('keeps anonymous entries stable across reloads without writing', async () => {
    const anonymous = { name: './config-plugin', config: { tag: 'anon', value: 1 } }
    const text = yaml.dump([anonymous, plugin('b', 1)])
    const app = await setup('tmp-sync-anonymous.yml', text)
    expect(app.config('anon').value).toBe(1)
    expect(await app.text()).toBe(text)
    const applies = applied.filter(tag => tag === 'anon').length

    const edited = yaml.dump([anonymous, plugin('b', 2)])
    await writeFile(app.filename, edited)
    await app.settle()

    expect(app.config('b').value).toBe(2)
    expect(applied.filter(tag => tag === 'anon')).toHaveLength(applies)
    expect(await app.text()).toBe(edited)

    // the assigned id travels with the next write
    await app.update('b', { config: { tag: 'b', value: 3 } })
    await app.settle()
    const [first] = await app.read()
    expect(first.id).toMatch(/^[0-9a-f]{8}$/)
    expect(first.config.tag).toBe('anon')
  }, 10000)

  it('keeps runtime changes in memory when the file is read-only', async () => {
    const app = await setup('tmp-sync-readonly.yml', [plugin('a', 1), plugin('b', 1)])
    const text = await app.text()
    await chmod(app.filename, 0o444)

    await app.update('a', { config: { tag: 'a', value: 2 } })
    await app.settle()

    expect(app.config('a').value).toBe(2)
    expect(await app.text()).toBe(text)
    expect(app.logs('warn').some(line => line.includes('read-only'))).toBe(true)

    // an unrelated file edit keeps the in-memory overlay
    await chmod(app.filename, 0o644)
    await writeFile(app.filename, yaml.dump([plugin('a', 1), plugin('b', 2)]))
    await chmod(app.filename, 0o444)
    await app.settle()

    expect(app.config('a').value).toBe(2)
    expect(app.config('b').value).toBe(2)
    expect((await app.read())[0].config.value).toBe(1)
  }, 10000)

  it('removes a nested entry through its composite id', async () => {
    const app = await setup('tmp-sync-nested-remove.yml', [plugin('a', 1), plugin('b', 1)])

    // the public id is `<include>:<local>`; the group's store is keyed by the local id
    app.ctx.loader.remove(`${app.id}:a`)
    await app.settle()

    expect(app.config('a')).toBeUndefined()
    expect(app.config('b').value).toBe(1)
    expect(app.include().store['a']).toBeUndefined()
    expect((await app.read()).map(entry => entry.id)).toEqual(['b'])
  }, 10000)

  it('flushes pending changes on dispose', async () => {
    const app = await setup('tmp-sync-dispose.yml', [plugin('a', 1)])

    const task = app.update('a', { config: { tag: 'a', value: 2 } })
    await fiber!.dispose()
    await task.catch(() => {})

    expect((await app.read())[0].config.value).toBe(2)
  }, 10000)
})
