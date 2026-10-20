import { expect, describe, it, beforeAll } from 'vitest'
import { Context } from 'cordis'
import MockLoader, { sleep } from './utils'

const GROUP = '@cordisjs/plugin-group'
const e = (id: string, name: string) => ({ id, name })

describe('Group: concurrent reconciliation with colliding ids', () => {
  const root = new Context()

  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    for (const n of ['foo', 'bar', 'baz']) loader.mock(n, () => {})
  })

  const active = () => ['foo', 'bar', 'baz']
    .filter(n => !!root.registry.get(loader.modules[n]))

  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await loader.await()
      await sleep(2)
    }
  }

  it('does not leave a stale plugin running when an id moves across groups', async () => {
    // A config may name one id twice, and the same id may appear under two
    // groups at once. Reconciling both groups in the same turn then has a
    // removal and a creation of that id in flight together.
    await loader.create({ id: 'g1', name: GROUP, group: true, config: [e('1', 'foo'), e('2', 'baz')] })
    await loader.create({ id: 'g2', name: GROUP, group: true, config: [e('2', 'bar')] })
    await settle()

    await Promise.all([
      loader.update('g1', { config: [e('3', 'foo'), e('3', 'foo')] }),
      loader.update('g2', { config: [e('2', 'foo'), e('3', 'foo')] }),
    ])
    await settle()

    await Promise.all([
      loader.update('g1', { config: [e('3', 'baz'), e('2', 'baz')] }),
      loader.update('g2', { config: [] }),
    ])
    await settle()

    // Both surviving entries ask for `baz`; nothing asks for `foo` any more.
    expect(active()).to.deep.equal(['baz'])
  })
})
