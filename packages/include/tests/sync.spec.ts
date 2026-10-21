import { expect, describe, it } from 'vitest'
import { readFile, chmod, writeFile } from 'node:fs/promises'
import * as yaml from 'js-yaml'
import Include from '../src/index.ts'
import type { PatchOptions } from '../src/patch.ts'
import { applied } from './fixtures/config-plugin.ts'
import { fixture, group, harness, plugin } from './utils.ts'

describe('Include sync', () => {
  const { setup } = harness()

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
    app.files.push(inner)
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
    app.files.push(inner)
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

  describe('entries inserted and overridden by patches', () => {
    const config = (value: number) => ({ tag: 'x', value })
    const scenarios: { name: string; patches: PatchOptions[]; expected: PatchOptions[]; initial: number }[] = [
      {
        name: 'last override',
        patches: [{ insert: [plugin('x', 1)] }, { id: 'x', config: config(2) }],
        expected: [{ insert: [plugin('x', 1, { disabled: false })] }, { id: 'x', config: config(3) }],
        initial: 2,
      },
      {
        name: 'multiple overrides',
        patches: [{ insert: [plugin('x', 1)] }, { id: 'x', config: config(0) }, { id: 'x', config: config(2) }],
        expected: [{ insert: [plugin('x', 1, { disabled: false })] }, { id: 'x', config: config(0) }, { id: 'x', config: config(3) }],
        initial: 2,
      },
      {
        name: 'insertion without overrides',
        patches: [{ insert: [plugin('x', 1)] }],
        expected: [{ insert: [plugin('x', 3, { disabled: false })] }],
        initial: 1,
      },
      {
        name: 'skipped override before insertion',
        patches: [{ id: 'x', config: config(2) }, { insert: [plugin('x', 1)] }],
        expected: [{ id: 'x', config: config(2) }, { insert: [plugin('x', 3, { disabled: false })] }],
        initial: 1,
      },
      {
        name: 'skipped name mismatch',
        patches: [{ insert: [plugin('x', 1)] }, { id: 'x', config: config(2) }, { id: 'x', name: 'wrong-plugin', config: config(9) }],
        expected: [{ insert: [plugin('x', 1, { disabled: false })] }, { id: 'x', config: config(3) }, { id: 'x', name: 'wrong-plugin', config: config(9) }],
        initial: 2,
      },
    ]

    for (const scenario of scenarios) {
      it(`persists each key to its effective owner (${scenario.name})`, async () => {
        const inner = fixture('tmp-owner-inner.yml')
        const innerText = yaml.dump([plugin('a', 1)])
        await writeFile(inner, innerText)
        const app = await setup('tmp-owner-outer.yml', [{
          id: 'inc',
          name: '@cordisjs/plugin-include',
          config: {
            path: './tmp-owner-inner.yml',
            patches: scenario.patches,
          },
        }])
        app.files.push(inner)
        const include = () => app.include().store['inc']!.subtree as Include
        expect(app.config('x').value).toBe(scenario.initial)

        await app.update('inc:x', { config: config(3), disabled: false })
        await include().refresh()
        await app.settle()

        expect(app.config('x').value).toBe(3)
        const [entry] = await app.read()
        expect(entry.config.patches).toEqual(scenario.expected)
        expect(await readFile(inner, 'utf8')).toBe(innerText)
        expect(app.logs('error')).toEqual([])
      }, 10000)
    }
  })

  it('routes past a name-mismatched override', async () => {
    const inner = fixture('tmp-file-owner-inner.yml')
    await writeFile(inner, yaml.dump([plugin('x', 1)]))
    // `applyPatches` skips this patch, so it owns nothing and the change is the file's
    const patches: PatchOptions[] = [{ id: 'x', name: 'wrong-plugin', config: { tag: 'x', value: 2 } }]
    const app = await setup('tmp-file-owner-outer.yml', [{
      id: 'inc',
      name: '@cordisjs/plugin-include',
      config: {
        path: './tmp-file-owner-inner.yml',
        patches,
      },
    }])
    app.files.push(inner)
    const include = () => app.include().store['inc']!.subtree as Include
    expect(app.config('x').value).toBe(1)

    await app.update('inc:x', { config: { tag: 'x', value: 3 } })
    await include().refresh()
    await app.settle()

    expect(app.config('x').value).toBe(3)
    const [entry] = await app.read()
    expect(entry.config.patches).toEqual(patches)
    expect(yaml.load(await readFile(inner, 'utf8'))).toEqual([plugin('x', 3)])
    expect(app.logs('error')).toEqual([])
  }, 10000)

  describe('entries of a group config replaced by a patch', () => {
    async function start(name: string, config: any[] = [plugin('a', 1)]) {
      const inner = fixture(`tmp-sync-inner-${name}.yml`)
      const innerText = yaml.dump([group('g', [plugin('hidden', 1)])])
      await writeFile(inner, innerText)
      const app = await setup(`tmp-sync-outer-${name}.yml`, [{
        id: 'inc',
        name: '@cordisjs/plugin-include',
        config: {
          path: `./tmp-sync-inner-${name}.yml`,
          patches: [{ id: 'g', config }],
        },
      }])
      app.files.push(inner)
      const innerInclude = () => app.include().store['inc']!.subtree as Include
      await innerInclude().refresh()
      await app.ctx.loader.await()
      expect(app.config('a').value).toBe(1)
      expect(app.config('hidden')).toBeUndefined()
      const settle = async () => {
        await innerInclude().refresh()
        await app.settle()
      }
      return { ...app, inner, innerText, innerInclude, settle }
    }

    it('routes changes into the patch', async () => {
      const app = await start('group-update')
      await app.update('inc:a', { config: { tag: 'a', value: 2 } })
      await app.settle()

      expect(app.config('a').value).toBe(2)
      expect(await readFile(app.inner, 'utf8')).toBe(app.innerText)
      const [entry] = await app.read()
      expect(entry.config.patches).toEqual([{ id: 'g', config: [plugin('a', 2)] }])
    }, 10000)

    it('places new entries into the patch', async () => {
      const app = await start('group-create')
      await app.ctx.loader.create({ name: './config-plugin', config: { tag: 'b', value: 1 } }, `${app.id}:inc:g`)
      await app.settle()

      expect(app.config('b').value).toBe(1)
      expect(await readFile(app.inner, 'utf8')).toBe(app.innerText)
      const [entry] = await app.read()
      expect(entry.config.patches).toEqual([{ id: 'g', config: [plugin('a', 1), expect.objectContaining({ config: { tag: 'b', value: 1 } })] }])
    }, 10000)

    it('removes entries from the patch', async () => {
      const app = await start('group-remove')
      app.ctx.loader.remove(`${app.id}:inc:a`)
      await app.settle()

      expect(app.config('a')).toBeUndefined()
      expect(await readFile(app.inner, 'utf8')).toBe(app.innerText)
      const [entry] = await app.read()
      expect(entry.config.patches).toEqual([{ id: 'g', config: [] }])
    }, 10000)

    it('keeps anonymous entries across file edits', async () => {
      const app = await start('group-anon', [{ name: './config-plugin', config: { tag: 'a', value: 1 } }])
      const find = () => Object.values(app.innerInclude().store).find(entry => entry.options.config?.tag === 'a')
      const before = find()

      await writeFile(app.inner, '# touched\n' + app.innerText)
      await app.settle()
      expect(find()).toBe(before)
    }, 10000)
  })

  it('routes an edit to an entry whose group moved in the same batch', async () => {
    const inner = fixture('tmp-sync-inner-batch-move.yml')
    await writeFile(inner, yaml.dump([group('h', [])]))
    const app = await setup('tmp-sync-outer-batch-move.yml', [{
      id: 'inc',
      name: '@cordisjs/plugin-include',
      config: {
        path: './tmp-sync-inner-batch-move.yml',
        patches: [{ insert: [group('g', [plugin('x', 1)])] }],
      },
    }])
    app.files.push(inner)
    const innerInclude = () => app.include().store['inc']!.subtree as Include
    await innerInclude().refresh()
    await app.ctx.loader.await()

    // both changes are reported before either is written
    await Promise.all([
      app.ctx.loader.update(`${app.id}:inc:g`, {}, `${app.id}:inc:h`),
      app.update('inc:x', { config: { tag: 'x', value: 2 } }),
    ])
    await innerInclude().flush()
    await app.settle()

    expect(app.config('x').value).toBe(2)
    expect(app.logs('error')).toEqual([])
    expect(yaml.load(await readFile(inner, 'utf8'))).toEqual([group('h', [group('g', [plugin('x', 2)])])])
    const [entry] = await app.read()
    expect(entry.config.patches).toEqual([{ insert: [] }])
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

  it('does not give a root anonymous plugin the nested plugin\'s id', async () => {
    const shape = () => ({ name: './config-plugin', config: { tag: 'x', value: 1 } })
    const app = await setup('tmp-sync-anon-root.yml', yaml.dump([
      { name: '@cordisjs/plugin-group', group: true, config: [shape()] },
      shape(),
    ]))

    const includeId = app.include().ctx.fiber.entry!.options.id
    const tagged = Object.values(app.include().store).filter(entry => entry.options.config?.tag === 'x')
    const root = tagged.find(entry => entry.parent.ctx.fiber.entry!.options.id === includeId)
    const nested = tagged.find(entry => entry.parent.ctx.fiber.entry!.options.id !== includeId)
    expect(root).toBeTruthy()
    expect(nested).toBeTruthy()
    expect(root).not.toBe(nested)
    const rootId = root!.options.id
    const nestedId = nested!.options.id
    expect(nested!.parent.ctx.fiber.entry!.options.id).toBe(
      Object.values(app.include().store).find(entry => entry.options.group)!.options.id,
    )
    const applies = applied.filter(tag => tag === 'x').length

    await writeFile(app.filename, yaml.dump([shape()]))
    await app.settle()

    const surviving = Object.values(app.include().store).filter(entry => entry.options.config?.tag === 'x')
    expect(surviving).toHaveLength(1)
    expect(surviving[0]).toBe(root)
    expect(surviving[0]!.options.id).toBe(rootId)
    expect(surviving[0]!.options.id).not.toBe(nestedId)
    expect(applied.filter(tag => tag === 'x')).toHaveLength(applies)
  }, 10000)

  it('keeps an anonymous group and its child stable when a neighbor changes', async () => {
    const child = { name: './config-plugin', config: { tag: 'child', value: 1 } }
    const anonGroup = { name: '@cordisjs/plugin-group', group: true, config: [child] }
    const app = await setup('tmp-sync-anon-neighbor.yml', yaml.dump([anonGroup, plugin('b', 1)]))

    const includeId = app.include().ctx.fiber.entry!.options.id
    const groupEntry = Object.values(app.include().store).find(entry => entry.options.group)
    const childEntry = Object.values(app.include().store).find(entry => entry.options.config?.tag === 'child')
    expect(groupEntry?.parent.ctx.fiber.entry!.options.id).toBe(includeId)
    expect(childEntry?.parent.ctx.fiber.entry!.options.id).toBe(groupEntry!.options.id)
    const groupId = groupEntry!.options.id
    const childId = childEntry!.options.id
    const childApplies = applied.filter(tag => tag === 'child').length

    await writeFile(app.filename, yaml.dump([anonGroup, plugin('b', 2)]))
    await app.settle()

    expect(app.config('b').value).toBe(2)
    expect(app.include().store[groupId]).toBe(groupEntry)
    expect(app.include().store[childId]).toBe(childEntry)
    expect(groupEntry!.options.id).toBe(groupId)
    expect(childEntry!.options.id).toBe(childId)
    expect(childEntry!.parent.ctx.fiber.entry!.options.id).toBe(groupId)
    expect(applied.filter(tag => tag === 'child')).toHaveLength(childApplies)
  }, 10000)

  it('does not reuse an id that the file now writes explicitly', async () => {
    const anonymous = { name: './config-plugin', config: { tag: 'anon', value: 1 } }
    const app = await setup('tmp-sync-explicit-id.yml', yaml.dump([anonymous]))
    const [live] = Object.values(app.include().store)
    const id = live!.options.id
    expect(await app.text()).not.toContain(id)

    await writeFile(app.filename, yaml.dump([
      anonymous,
      { id, name: './config-plugin', config: { tag: 'other', value: 1 } },
    ]))
    await app.settle()

    const store = app.include().store
    expect(store[id]!.options.config).toEqual({ tag: 'other', value: 1 })
    const anon = Object.values(store).find(entry => entry.options.config?.tag === 'anon')
    expect(anon?.options.id).toBeTruthy()
    expect(anon!.options.id).not.toBe(id)
    expect(store[anon!.options.id]).toBe(anon)
  }, 10000)

  it('does not reuse an id owned by an explicit patch insert', async () => {
    const name = 'tmp-sync-patch-insert.yml'
    const anonymous = { name: './config-plugin', config: { tag: 'anon', value: 1 } }
    const app = await setup(name, yaml.dump([anonymous]))
    const [live] = Object.values(app.include().store)
    const id = live!.options.id
    expect(await app.text()).not.toContain(id)

    await app.ctx.loader.update(app.id, {
      config: {
        path: `./fixtures/${name}`,
        patches: [{ insert: [{ id, name: './config-plugin', config: { tag: 'other', value: 9 } }] }],
      },
    })
    await app.ctx.loader.await()

    // a byte change forces a reread; the assigned id stays out of the file
    await writeFile(app.filename, `# reread\n${yaml.dump([anonymous])}`)
    await app.settle()

    const store = app.include().store
    expect(store[id]!.options.config).toEqual({ tag: 'other', value: 9 })
    const anon = Object.values(store).find(entry => entry.options.config?.tag === 'anon')
    expect(anon?.options.id).toBeTruthy()
    expect(anon!.options.id).not.toBe(id)
    expect(store[anon!.options.id]).toBe(anon)
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

  it('retries a write that failed earlier when disposing', async () => {
    const app = await setup('tmp-sync-dispose-retry.yml', [plugin('a', 1)])
    const text = await app.text()
    await chmod(app.filename, 0o444)

    await app.update('a', { config: { tag: 'a', value: 2 } })
    await app.settle()
    expect(await app.text()).toBe(text)

    // the file becomes writable again, but nothing else touches the tree
    await chmod(app.filename, 0o644)
    await app.dispose()

    expect((await app.read())[0].config.value).toBe(2)
  }, 10000)

  it('flushes pending changes on dispose', async () => {
    const app = await setup('tmp-sync-dispose.yml', [plugin('a', 1)])

    const task = app.update('a', { config: { tag: 'a', value: 2 } })
    await app.dispose()
    await task.catch(() => {})

    expect((await app.read())[0].config.value).toBe(2)
  }, 10000)
})
