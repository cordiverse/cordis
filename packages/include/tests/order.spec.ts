import { expect, describe, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import * as yaml from 'js-yaml'
import { group, harness, plugin } from './utils'

describe('Include same-parent order', () => {
  const { setup } = harness()

  it('persists moving an earlier sibling later', async () => {
    const app = await setup('tmp-order-later.yml', [plugin('a', 1), plugin('b', 1), plugin('c', 1)])

    await app.include().update('a', {}, null, 2)
    await app.settle()

    expect((await app.read()).map(entry => entry.id)).toEqual(['b', 'c', 'a'])
    expect(app.include().root.data.map(entry => entry.id)).toEqual(['b', 'c', 'a'])
    expect(app.logs('error')).toEqual([])
  }, 10000)

  it('persists moving a later sibling earlier', async () => {
    const app = await setup('tmp-order-earlier.yml', [plugin('a', 1), plugin('b', 1), plugin('c', 1)])

    await app.include().update('c', {}, null, 0)
    await app.settle()

    expect((await app.read()).map(entry => entry.id)).toEqual(['c', 'a', 'b'])
    expect(app.include().root.data.map(entry => entry.id)).toEqual(['c', 'a', 'b'])
  }, 10000)

  it('persists the later of two reorders flushed together', async () => {
    const app = await setup('tmp-order-twice.yml', [plugin('a', 1), plugin('b', 1), plugin('c', 1), plugin('d', 1)])

    const first = app.include().update('a', {}, null, 1)
    const second = app.include().update('a', {}, null, 3)
    await first
    await second
    await app.settle()

    expect((await app.read()).map(entry => entry.id)).toEqual(['b', 'c', 'd', 'a'])
  }, 10000)

  it('persists two sibling reorders flushed together', async () => {
    const app = await setup('tmp-order-siblings.yml', [plugin('a', 1), plugin('b', 1), plugin('c', 1), plugin('d', 1)])

    const first = app.include().update('c', {}, null, 0)
    const second = app.include().update('a', {}, null, 3)
    await first
    await second
    await app.settle()

    expect((await app.read()).map(entry => entry.id)).toEqual(['c', 'b', 'd', 'a'])
  }, 10000)

  it('lets the file win when both sides reorder the same entry', async () => {
    const app = await setup('tmp-order-conflict.yml', [plugin('a', 1), plugin('b', 1), plugin('c', 1)])

    await writeFile(app.filename, yaml.dump([plugin('b', 1), plugin('a', 1), plugin('c', 1)]))
    await app.include().update('a', {}, null, 2)
    await app.settle()

    expect((await app.read()).map(entry => entry.id)).toEqual(['b', 'a', 'c'])
    expect(app.include().root.data.map(entry => entry.id)).toEqual(['b', 'a', 'c'])
    const errors = app.logs('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/conflict/)
    expect(errors[0]).toMatch(/file wins/)
    expect(errors[0]).toMatch(/moved both/)
  }, 10000)

  it('does not reorder siblings on a config edit', async () => {
    const app = await setup('tmp-order-config.yml', [plugin('a', 1), plugin('b', 1), plugin('c', 1)])

    await app.include().update('a', { config: { tag: 'a', value: 2 } })
    await app.settle()

    const entries = await app.read()
    expect(entries.map(entry => entry.id)).toEqual(['a', 'b', 'c'])
    expect(entries[0].config.value).toBe(2)
    expect(app.logs('error')).toEqual([])
  }, 10000)

  it('keeps a runtime reorder across a non-order file edit', async () => {
    const app = await setup('tmp-order-merge.yml', [plugin('a', 1), plugin('b', 1), plugin('c', 1)])

    await writeFile(app.filename, yaml.dump([plugin('a', 9), plugin('b', 1), plugin('c', 1)]))
    await app.include().update('a', {}, null, 2)
    await app.settle()

    const entries = await app.read()
    expect(entries.map(entry => entry.id)).toEqual(['b', 'c', 'a'])
    expect(entries.find(entry => entry.id === 'a').config.value).toBe(9)
    expect(app.include().root.data.map(entry => entry.id)).toEqual(['b', 'c', 'a'])
    expect(app.config('a').value).toBe(9)
    expect(app.logs('error')).toEqual([])
  }, 10000)

  it('keeps an earlier placement when a later edit does not move', async () => {
    const app = await setup('tmp-order-edit-after.yml', [plugin('a', 1), plugin('b', 1), plugin('c', 1)])

    const move = app.include().update('a', {}, null, 2)
    const edit = app.include().update('a', { config: { tag: 'a', value: 4 } })
    await move
    await edit
    await app.settle()

    const entries = await app.read()
    expect(entries.map(entry => entry.id)).toEqual(['b', 'c', 'a'])
    expect(entries.find(entry => entry.id === 'a').config.value).toBe(4)
  }, 10000)

  it('persists a reorder inside a nested group', async () => {
    const app = await setup('tmp-order-group.yml', [group('g', [plugin('a', 1), plugin('b', 1), plugin('c', 1)])])

    await app.include().update('b', {}, 'g', 0)
    await app.settle()

    const [entry] = await app.read()
    expect(entry.config.map((child: { id: string }) => child.id)).toEqual(['b', 'a', 'c'])
    expect(app.logs('error')).toEqual([])
  }, 10000)

  it('persists a move into another group', async () => {
    const app = await setup('tmp-order-cross.yml', [plugin('a', 1), plugin('b', 1), group('g', [])])

    await app.include().update('a', {}, 'g', 0)
    await app.settle()

    const entries = await app.read()
    expect(entries.map(entry => entry.id)).toEqual(['b', 'g'])
    expect(entries.find(entry => entry.id === 'g').config).toEqual([plugin('a', 1)])
  }, 10000)

  it('persists an entry reordered again after a sibling', async () => {
    const app = await setup('tmp-order-interleaved.yml', [plugin('a', 1), plugin('b', 1), plugin('c', 1), plugin('d', 1)])

    const first = app.include().update('a', {}, null, 3)
    const second = app.include().update('b', {}, null, 2)
    const third = app.include().update('a', {}, null, 0)
    await first
    await second
    await third
    await app.settle()

    expect((await app.read()).map(entry => entry.id)).toEqual(['a', 'c', 'd', 'b'])
    expect(app.include().root.data.map(entry => entry.id)).toEqual(['a', 'c', 'd', 'b'])
    expect(app.logs('error')).toEqual([])
  }, 10000)

  it('lets the file win when both sides move an entry into the same group', async () => {
    const app = await setup('tmp-order-both-group.yml', [plugin('a', 1), group('g', [plugin('x', 1)])])

    await writeFile(app.filename, yaml.dump([group('g', [plugin('x', 1), plugin('a', 1)])]))
    await app.include().update('a', {}, 'g', 0)
    await app.settle()

    const [entry] = await app.read()
    expect(entry.id).toBe('g')
    expect(entry.config.map((child: { id: string }) => child.id)).toEqual(['x', 'a'])
    expect(app.include().root.data[0].config.map((child: { id: string }) => child.id)).toEqual(['x', 'a'])
    const errors = app.logs('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/conflict/)
    expect(errors[0]).toMatch(/file wins/)
    expect(errors[0]).toMatch(/moved both/)
  }, 10000)

  it('does not replay the runtime index when a key change survives that conflict', async () => {
    const app = await setup('tmp-order-both-group-key.yml', [plugin('a', 1), group('g', [plugin('x', 1)])])

    await writeFile(app.filename, yaml.dump([group('g', [plugin('x', 1), plugin('a', 1)])]))
    await app.include().update('a', { disabled: true }, 'g', 0)
    await app.settle()

    const [entry] = await app.read()
    expect(entry.config.map((child: { id: string, disabled?: boolean }) => [child.id, child.disabled])).toEqual([['x', undefined], ['a', true]])
    expect(app.logs('error').some(line => line.includes('moved both'))).toBe(true)
  }, 10000)

  it('does not conflict when both sides place an entry at the same index', async () => {
    const app = await setup('tmp-order-both-group-same.yml', [plugin('a', 1), group('g', [plugin('x', 1)])])

    await writeFile(app.filename, yaml.dump([group('g', [plugin('a', 1), plugin('x', 1)])]))
    await app.include().update('a', {}, 'g', 0)
    await app.settle()

    const [entry] = await app.read()
    expect(entry.config.map((child: { id: string }) => child.id)).toEqual(['a', 'x'])
    expect(app.logs('error')).toEqual([])
  }, 10000)

  it('refreshes a cross-parent index after a later reorder in that group', async () => {
    const app = await setup('tmp-order-cross-restamp.yml', [
      plugin('a', 1),
      group('g', [plugin('x', 1), plugin('y', 1), plugin('z', 1)]),
    ])

    const first = app.include().update('y', {}, 'g', 0)
    const second = app.include().update('a', {}, 'g', 1)
    const third = app.include().update('y', {}, 'g', 3)
    await first
    await second
    await third
    await app.settle()

    const [entry] = await app.read()
    expect(entry.config.map((child: { id: string }) => child.id)).toEqual(['a', 'x', 'z', 'y'])
    expect(app.include().root.data[0].config.map((child: { id: string }) => child.id)).toEqual(['a', 'x', 'z', 'y'])
    expect(app.logs('error')).toEqual([])
  }, 10000)

  it('conflicts when a later reorder changes the cross-parent index the file already chose', async () => {
    const app = await setup('tmp-order-cross-conflict.yml', [plugin('a', 1), group('g', [plugin('x', 1), plugin('y', 1)])])

    await writeFile(app.filename, yaml.dump([group('g', [plugin('a', 1), plugin('y', 1), plugin('x', 1)])]))
    const first = app.include().update('a', {}, 'g', 0)
    const second = app.include().update('y', {}, 'g', 0)
    await first
    await second
    await app.settle()

    const [entry] = await app.read()
    expect(entry.config.map((child: { id: string }) => child.id)).toEqual(['a', 'y', 'x'])
    expect(app.include().root.data[0].config.map((child: { id: string }) => child.id)).toEqual(['a', 'y', 'x'])
    const errors = app.logs('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/moved both/)
    expect(errors[0]).toMatch(/file wins/)
  }, 10000)

  it('keeps a same-parent reorder when a later cross-parent move conflicts', async () => {
    const app = await setup('tmp-order-sibling-survives.yml', [plugin('a', 1), group('g', [plugin('x', 1), plugin('y', 1)])])

    await writeFile(app.filename, yaml.dump([group('g', [plugin('x', 1), plugin('y', 1), plugin('a', 1)])]))
    const first = app.include().update('y', {}, 'g', 0)
    const second = app.include().update('a', {}, 'g', 0)
    await first
    await second
    await app.settle()

    const [entry] = await app.read()
    expect(entry.config.map((child: { id: string }) => child.id)).toEqual(['y', 'x', 'a'])
    expect(app.include().root.data[0].config.map((child: { id: string }) => child.id)).toEqual(['y', 'x', 'a'])
    expect(app.logs('error').some(line => line.includes('moved both'))).toBe(true)
  }, 10000)

  it('logs a conflict when the file order disagrees with a shared snapshot', async () => {
    const app = await setup('tmp-order-snapshot-conflict.yml', [plugin('a', 1), plugin('b', 1), plugin('c', 1), plugin('d', 1)])

    await writeFile(app.filename, yaml.dump([plugin('a', 1), plugin('c', 1), plugin('b', 1), plugin('d', 1)]))
    const first = app.include().update('a', {}, null, 3)
    const second = app.include().update('b', {}, null, 2)
    const third = app.include().update('a', {}, null, 0)
    await first
    await second
    await third
    await app.settle()

    expect((await app.read()).map(entry => entry.id)).toEqual(['a', 'c', 'b', 'd'])
    expect(app.include().root.data.map(entry => entry.id)).toEqual(['a', 'c', 'b', 'd'])
    const errors = app.logs('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/moved both/)
    expect(errors[0]).toMatch(/file wins/)
  }, 10000)

  it('keeps a sibling reorder when only the other entry conflicts', async () => {
    const app = await setup('tmp-order-partial-conflict.yml', [plugin('a', 1), plugin('b', 1), plugin('c', 1), plugin('d', 1)])

    await writeFile(app.filename, yaml.dump([plugin('d', 1), plugin('a', 1), plugin('c', 1), plugin('b', 1)]))
    const first = app.include().update('c', {}, null, 0)
    const second = app.include().update('d', {}, null, 1)
    await first
    await second
    await app.settle()

    expect((await app.read()).map(entry => entry.id)).toEqual(['d', 'c', 'a', 'b'])
    expect(app.include().root.data.map(entry => entry.id)).toEqual(['d', 'c', 'a', 'b'])
    const errors = app.logs('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/moved both/)
    expect(errors[0]).toMatch(/\bd\b/)
  }, 10000)

  it('does not write a patch-owned value into the file when reordering', async () => {
    const app = await setup('tmp-order-patch.yml', [plugin('a', 1), plugin('b', 1), plugin('c', 1)], {
      patches: [{ id: 'a', config: { tag: 'a', value: 7 } }],
    })
    expect(app.config('a').value).toBe(7)

    await app.include().update('a', {}, null, 2)
    await app.settle()

    const entries = await app.read()
    expect(entries.map(entry => entry.id)).toEqual(['b', 'c', 'a'])
    expect(entries.find(entry => entry.id === 'a').config.value).toBe(1)
    expect(app.config('a').value).toBe(7)
    expect(app.include().config.patches).toEqual([{ id: 'a', config: { tag: 'a', value: 7 } }])
    expect(app.logs('error')).toEqual([])
  }, 10000)
})
