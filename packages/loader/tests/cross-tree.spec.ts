import { Context, Service } from 'cordis'
import { expect, describe, it, beforeAll } from 'vitest'
import MockLoader, { sleep } from './utils'
import { EntryChange, EntryTree } from '../src'

// An entry that mounts its own tree, as a config-file entry does: the children
// it declares live in a `store` of their own.
describe('Loader: cross-tree move', () => {
  const root = new Context()

  let loader!: MockLoader

  class Tree extends EntryTree {
    commit(change: EntryChange) {}

    import(name: string) {
      return loader.import(name)
    }

    async* [Service.init]() {
      yield async () => {
        await sleep()
        this.root.stop()
      }
      await this.root.update([{ id: 'a', name: 'bar' }])
    }
  }

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('bar', () => {})
    loader.modules['tree'] = Tree as any
  })

  it('carries the entry into the store of the tree it moves to', async () => {
    await loader.read([{ id: '1', name: 'tree' }])
    await sleep()
    const entry = loader.resolve('1:a')
    const subtree = loader.resolve('1').subtree!
    // `to.equal` on an entry would print its context, so compare by identity
    expect(loader.store['a'] === entry).to.equal(false)
    expect(subtree.store['a'] === entry).to.equal(true)

    await loader.update('1:a', { config: {} }, null)
    await sleep()

    expect(entry.parent === loader.root).to.equal(true)
    expect(loader.store['a'] === entry).to.equal(true)
    expect(() => loader.resolve('a')).to.not.throw()
    // the tree it left no longer owns it, and neither tree yields it twice
    expect(subtree.store['a'] === entry).to.equal(false)
    expect([...loader.entries()].filter((item) => item === entry)).to.have.length(1)

    await root.fiber.dispose()
  })
})
