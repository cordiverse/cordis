import { describe, expect, it, beforeAll } from 'vitest'
import { Context, FiberState } from 'cordis'
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
      name: '@cordisjs/group',
      group: true,
      config: [{ id: '1', name: 'foo' }],
    })
    await sleep()
    loader.expectFiber('1')
  })

  // `Entry.init()` reuses the in-flight task (`_initTask ??= _init(disposeTask)`),
  // so an update arriving mid-import neither imports again nor adds a second fiber.
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

  // `Entry.refresh()` returns early once the entry has an outer or an inner
  // fiber, so a refresh cannot restart an entry that is already running.
  //
  // Counted by how often the component runs, not by identity: `Fiber.restart()`
  // calls `_refresh()` on the same fiber, so `entry.innerFiber` is the same object
  // either way, and `state` is a numeric enum where only PENDING is falsy -- the two
  // assertions that were here before passed whether or not the early return existed.
  //
  // The guard is enforced twice: `refresh()` returns on a live fiber, and `_init()`
  // returns on `innerFiber?.uid`, so removing either one leaves this case green and
  // only removing both makes it fail (`2` runs instead of `1`). What it pins is the
  // property, not either line.
  it('refresh is a no-op once the entry has a fiber', async () => {
    const applyCalls = loader.mock('noop', () => {})
    await loader.create({ id: 'noop', name: 'noop' })
    await loader.await()

    const entry = loader.store['noop']
    const fiber = entry.innerFiber
    expect(fiber).to.be.ok
    const runs = applyCalls.mock.calls.length
    expect(runs, 'the component ran once when the entry was created').to.equal(1)

    await entry.refresh()
    await loader.await()

    expect(applyCalls.mock.calls.length, 'a refresh must not run the component again').to.equal(runs)
    expect(entry.innerFiber).to.equal(fiber)
    expect(fiber.state).to.equal(FiberState.ACTIVE)
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
