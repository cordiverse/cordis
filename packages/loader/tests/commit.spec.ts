import { Mock, mock } from 'node:test'
import { expect, describe, it, beforeAll, beforeEach } from 'vitest'
import { Context, Service } from 'cordis'
import { EntryChange, EntryTree, Group } from '../src/index.ts'
import MockLoader, { sleep } from './utils.ts'

describe('EntryTree.commit: change reports', () => {
  const root = new Context()

  let loader!: MockLoader
  let foo!: Mock<Function>

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    foo = loader.mock('foo', () => {})
  })

  beforeEach(() => {
    loader.changes = []
  })

  let id!: string
  let group!: string

  it('create reports a created entry with its id assigned', async () => {
    id = await loader.create({ name: 'foo', config: { a: 1 } })
    group = await loader.create({
      name: '@cordisjs/plugin-group',
      group: true,
      config: [],
    })

    expect(loader.changes).to.have.length(2)
    const [change] = loader.changes
    expect(change.id).to.equal(id)
    expect(change.group).to.equal(loader.root)
    expect(change.legacy).to.be.undefined
    expect(change.options).to.deep.equal({ id, name: 'foo', config: { a: 1 } })
    expect(loader.root.data).to.include(change.options)
  })

  it('update reports the new options together with the previous ones', async () => {
    await loader.update(id, { config: { a: 2 } })

    expect(loader.changes).to.have.length(1)
    const [change] = loader.changes
    expect(change.id).to.equal(id)
    expect(change.legacy).to.deep.equal({ id, name: 'foo', config: { a: 1 } })
    expect(change.options).to.deep.equal({ id, name: 'foo', config: { a: 2 } })
    // reported after the mutation
    expect(change.options).to.equal(loader.store[id]!.options)
  })

  it('move reports the target group', async () => {
    await loader.update(id, {}, group)

    expect(loader.changes).to.have.length(1)
    const [change] = loader.changes
    expect(change.group).to.equal(loader.store[group]!.subgroup)
    expect(change.from).to.equal(loader.root)
    expect(change.options).to.deep.equal(change.legacy)
  })

  it('update in place does not report a move', async () => {
    await loader.update(id, { config: { a: 4 } })

    expect(loader.changes).to.have.length(1)
    expect(loader.changes[0].from).to.be.undefined
  })

  it('fiber.update from inside the plugin reports a config change', async () => {
    const fiber = loader.expectFiber(id)
    await fiber.update({ a: 5 })

    expect(loader.changes).to.have.length(1)
    const [change] = loader.changes
    expect(change.legacy!.config).to.deep.equal({ a: 4 })
    expect(change.options!.config).to.deep.equal({ a: 5 })
  })

  it('remove reports the removed entry', async () => {
    await loader.remove(id)

    expect(loader.changes).to.have.length(1)
    const [change] = loader.changes
    expect(change.id).to.equal(id)
    expect(change.options).to.be.undefined
    expect(change.legacy!.name).to.equal('foo')
    expect(loader.store[id]).to.be.undefined
  })

  it('does not mistake a child fiber disposing itself for the entry (#19)', async () => {
    loader.mock('parent', (ctx: Context) => {
      const child = ctx.plugin(() => {})
      child.dispose()
    })
    const parent = await loader.create({ name: 'parent' })
    await sleep()

    loader.expectFiber(parent)
    expect(loader.store[parent]!.options.disabled).to.be.undefined
    expect(loader.changes.filter(change => change.options?.disabled)).to.have.length(0)
    await loader.remove(parent)
  })

  it('does not report anything for reads', async () => {
    expect(foo.mock.calls.length).to.be.greaterThan(0)
    await loader.read([
      { id: 'x', name: 'foo' },
      { id: group, name: '@cordisjs/plugin-group', group: true, config: [] },
    ])
    loader.changes = []

    // a removal driven by the config file is a read, so nothing is reported
    await loader.read([
      { id: group, name: '@cordisjs/plugin-group', group: true, config: [] },
    ])
    await sleep()
    expect(loader.changes).to.have.length(0)
    expect(loader.store['x']).to.be.undefined
  })
})

describe('EntryGroup.remove: file-driven moves', () => {
  const root = new Context()
  const dispose = mock.fn()

  let loader!: MockLoader
  let foo!: Mock<Function>

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    foo = loader.mock('foo', () => dispose)
  })

  it('keeps an entry that another group adopted', async () => {
    await loader.read([
      { id: 'x', name: 'foo' },
      { id: 'g', name: '@cordisjs/plugin-group', group: true, config: [] },
    ])
    expect(foo.mock.calls).to.have.length(1)

    await loader.read([
      { id: 'g', name: '@cordisjs/plugin-group', group: true, config: [{ id: 'x', name: 'foo' }] },
    ])
    await sleep()

    // whichever of remove / adopt ran first, the entry survives in the store
    expect(loader.store['x']).to.be.ok
    expect(loader.store['x']!.parent).to.equal(loader.store['g']!.subgroup)
    loader.expectFiber('x')
    loader.expectEnable(foo)
  })
})

describe('EntryTree.update: cross-tree moves', () => {
  const root = new Context()
  const changes: EntryChange[] = []

  let loader!: MockLoader
  let foo!: Mock<Function>

  class Tree extends EntryTree {
    static inject = ['loader']

    commit(change: EntryChange) {
      changes.push(change)
    }

    async import() {
      return Group
    }

    async [Service.init]() {
      await this.root.update([{ id: 'g', name: '@cordisjs/plugin-group', group: true, config: [] }])
    }
  }

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    foo = loader.mock('foo', () => {})
    loader.modules['tree'] = Tree
  })

  beforeEach(() => {
    loader.changes = []
    changes.length = 0
  })

  async function setup() {
    const id = await loader.create({ name: 'tree' })
    await loader.await()
    loader.changes = []
    return { id, subtree: loader.store[id]!.subtree! }
  }

  const running = () => root.registry.get(foo)?.fibers.length ?? 0

  it('reports a removal to the source tree and a creation to the target tree', async () => {
    const { id: tree, subtree } = await setup()
    const id = await loader.create({ name: 'foo', config: { a: 1 } })
    await loader.await()
    loader.changes = []

    await loader.update(id, { config: { a: 2 } }, `${tree}:g`)

    expect(loader.changes).to.have.length(1)
    expect(loader.changes[0].group).to.equal(loader.root)
    expect(loader.changes[0].options).to.be.undefined
    expect(loader.changes[0].legacy).to.deep.equal({ id, name: 'foo', config: { a: 1 } })

    expect(changes).to.have.length(1)
    const [change] = changes
    expect(change.group).to.equal(subtree.store['g']!.subgroup)
    expect(change.legacy).to.be.undefined
    expect(change.from).to.be.undefined
    expect(change.options).to.deep.equal({ id, name: 'foo', config: { a: 2 } })
    await loader.remove(`${tree}:${id}`)
  })

  it('transfers the entry to the store of the target tree', async () => {
    const { id: tree, subtree } = await setup()
    const id = await loader.create({ name: 'foo' })
    await loader.await()
    const entry = loader.store[id]!

    await loader.update(id, {}, `${tree}:g`)
    await loader.await()

    expect(loader.store[id]).to.be.undefined
    expect(subtree.store[id]).to.equal(entry)
    expect(loader.resolve(`${tree}:${id}`)).to.equal(entry)
    expect(entry.id).to.equal(`${tree}:${id}`)
    expect(running()).to.equal(1)

    // the target tree adopts the entry when it reconciles its source
    await subtree.store['g']!.subgroup!.update([{ ...entry.options }])
    await loader.await()
    expect(subtree.store[id]).to.equal(entry)
    expect(running()).to.equal(1)

    await loader.remove(`${tree}:${id}`)
    await loader.await()
    expect(running()).to.equal(0)
  })

  it('transfers the members of a moved group', async () => {
    const { id: tree, subtree } = await setup()
    const group = await loader.create({
      name: '@cordisjs/plugin-group',
      group: true,
      config: [{ id: 'member', name: 'foo' }],
    })
    await loader.await()
    const member = loader.store['member']!
    expect(running()).to.equal(1)

    await loader.update(group, {}, `${tree}:g`)
    await loader.await()

    expect(loader.store[group]).to.be.undefined
    expect(loader.store['member']).to.be.undefined
    expect(subtree.store['member']).to.equal(member)
    expect(subtree.store[group]!.subgroup!.tree).to.equal(subtree)
    expect(member.id).to.equal(`${tree}:member`)
    expect(running()).to.equal(1)

    await loader.remove(`${tree}:${group}`)
    await loader.await()
    expect(running()).to.equal(0)
  })

  it('rejects a move onto an id that the target tree already uses', async () => {
    const { id: tree, subtree } = await setup()
    const id = await loader.create({ id: 'g', name: 'foo' } as any)
    await loader.await()
    const entry = loader.store[id]!
    loader.changes = []

    await expect(loader.update(id, {}, `${tree}:g`)).rejects.toThrow()

    expect(loader.store[id]).to.equal(entry)
    expect(entry.parent).to.equal(loader.root)
    expect(loader.root.data).to.include(entry.options)
    expect(subtree.store['g']!.subgroup!.data).to.have.length(0)
    expect(loader.changes).to.have.length(0)
    expect(changes).to.have.length(0)
    await loader.remove(id)
  })
})

describe('EntryTree disposal', () => {
  it('does not persist child disposal while the tree loses its loader', async () => {
    const root = new Context()
    const loader = await root.plugin(MockLoader)
    const commit = mock.fn()
    let tree!: EntryTree
    class Tree extends EntryTree {
      static inject = ['loader']

      commit = commit

      async import() {
        return () => {}
      }

      async* [Service.init]() {
        tree = this
        await this.root.update([{ id: 'child', name: 'child' }])
        yield async () => {
          // Include flushes pending writes before stopping its entry group.
          await Promise.resolve()
          this.root.stop()
        }
      }
    }
    const fiber = await loader.ctx.plugin(Tree)
    const options = tree.root.data[0]
    await loader.dispose()
    expect(options.disabled).toBeUndefined()
    expect(commit.mock.calls).toHaveLength(0)
    await fiber.dispose()
  })
})
