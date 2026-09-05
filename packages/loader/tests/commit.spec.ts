import { Mock, mock } from 'node:test'
import { expect, describe, it, beforeAll, beforeEach } from 'vitest'
import { Context } from 'cordis'
import MockLoader, { sleep } from './utils'

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
    // reported after the mutation, not before
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

    // a removal driven by the config file must not be mistaken for a
    // self-dispose and written back as `disabled: true`
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
