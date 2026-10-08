import { Mock, mock } from 'node:test'
import { expect, describe, it, beforeAll, beforeEach } from 'vitest'
import { Context } from 'cordis'
import MockLoader, { sleep } from './utils'

/**
 * `Entry.init()` is reachable directly — `Entry.update()` calls it when the
 * entry has no fiber yet, `Loader.refresh()` calls it, and `Loader.import()`
 * does too. Only `refresh()` guards on `this.fiber`, so a second `init()` on an
 * entry that already started imports the module again and *replaces* the
 * running fiber: the first plugin instance is dropped without being disposed
 * and a new one is applied in its place.
 */
describe('Entry: init is idempotent', () => {
  const root = new Context()

  let loader!: MockLoader
  let plugin!: Mock<Function>

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    plugin = loader.mock('once', () => {})
  })

  beforeEach(() => {
    plugin.mock.resetCalls()
  })

  it('does not re-import a started entry', async () => {
    let imports = 0
    const load = loader.import
    loader.import = async (name: string) => {
      imports++
      return load.call(loader, name)
    }
    try {
      const id = await loader.create({ id: 'once', name: 'once' })
      await sleep()
      const first = loader.expectFiber(id)

      // A second init on the same entry: the fiber is already running, so this
      // must be a no-op rather than another import + apply.
      await loader.store[id].init()
      await sleep()

      expect(imports).toBe(1)
      expect(plugin.mock.calls.length).toBe(1)
      expect(loader.store[id].fiber).toBe(first)
    } finally {
      loader.import = load
    }
  })
})
