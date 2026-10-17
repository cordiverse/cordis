import { describe, expect, it, beforeAll } from 'vitest'
import { Context } from 'cordis'
import MockLoader, { sleep } from './utils'

// Entry initialization: imports performed while the first is in flight,
// whether refresh() restarts a running entry, and whether a failed import retries.
describe('Entry: initialization', () => {
  const root = new Context()

  let loader!: MockLoader
  let group!: string

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('foo', () => {})
  })

  it('initialize', async () => {
    group = await loader.create({
      name: '@cordisjs/plugin-group',
      group: true,
      config: [{ id: '1', name: 'foo' }],
    })
    await sleep()
    loader.expectFiber('1')
  })

  // `Entry.init()` reuses the in-flight task (`_initTask ??= _init()`), so an
  // update arriving mid-import neither imports again nor adds a second fiber.
  it('imports once when an update overlaps the import', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const load = loader.import
    let importCalls = 0
    loader.import = async (name: string, ...rest: any[]) => {
      if (name === 'baz') {
        importCalls++
        started.resolve()
        await release.promise
      }
      return load.call(loader, name, ...rest)
    }
    const applyCalls = loader.mock('baz', () => {})

    try {
      const config = [{ id: '1', name: 'foo' }, { id: '2', name: 'baz' }]
      const first = loader.update(group, { config })
      await started.promise
      const second = loader.update(group, { config })
      release.resolve()
      await Promise.all([first, second])
    } finally {
      loader.import = load
    }

    expect(importCalls).to.equal(1)
    expect(applyCalls.mock.calls).to.have.length(1)
    loader.expectFiber('2')
  })

  // `Entry.refresh()` returns early once the entry has a fiber, so a refresh
  // cannot restart an entry that is already running.
  it('refresh is a no-op once the entry has a fiber', async () => {
    const entry = loader.store['1']
    const fiber = entry.fiber
    expect(fiber).to.be.ok
    await entry.refresh()
    expect(entry.fiber).to.equal(fiber)
    expect(fiber.state).to.be.ok
  })

  // A failed import clears `_initTask` in `init()`'s finally block, so the next
  // update imports again.
  it('retries the import after a failure', async () => {
    const load = loader.import
    let attempts = 0
    loader.import = async (name: string, ...rest: any[]) => {
      if (name === 'qux') {
        attempts++
        if (attempts === 1) throw new Error('intentional import failure')
      }
      return load.call(loader, name, ...rest)
    }
    const applyCalls = loader.mock('qux', () => {})

    try {
      const config = [{ id: '1', name: 'foo' }, { id: '3', name: 'qux' }]
      await loader.update(group, { config })
      await loader.await()
      expect(applyCalls.mock.calls).to.have.length(0)

      await loader.update(group, { config })
      await loader.await()
      expect(applyCalls.mock.calls).to.have.length(1)
    } finally {
      loader.import = load
    }

    expect(attempts).to.equal(2)
    loader.expectFiber('3')
  })
})
