import { Context, Fiber, FiberState } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Logger from '@cordisjs/plugin-logger-console'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { expect, describe, it, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Hmr from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const templateDir = resolve(testDir, 'fixtures')
const fixtureDir = resolve(testDir, '__index__')

// Each group works on its own copy of the fixtures, so that the files in the
// repository are never modified.
function copyFixtures(group: string) {
  const dir = resolve(fixtureDir, group)
  cpSync(templateDir, dir, { recursive: true })
  return dir
}

// A file of a group's copy. `restore()` writes back the template.
function fixture(group: string, filename: string) {
  const path = resolve(fixtureDir, group, filename)
  const original = readFileSync(resolve(templateDir, filename), 'utf-8')
  return {
    path,
    original,
    modify(replaceFn: (content: string) => string) {
      writeFileSync(path, replaceFn(original))
    },
    write(content: string) {
      writeFileSync(path, content)
    },
    restore() {
      writeFileSync(path, original)
    },
  }
}

// Helper: wait for a condition
function waitFor(condFn: () => boolean | any, timeout = 8000, interval = 100): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const check = setInterval(() => {
      if (condFn()) {
        clearInterval(check)
        clearTimeout(timer)
        resolve()
      }
    }, interval)
    const timer = setTimeout(() => {
      clearInterval(check)
      reject(new Error('waitFor timed out'))
    }, timeout)
  })
}

async function createContext(group: string, configFile: string): Promise<{ ctx: Context; fiber: Fiber<Context> }> {
  const dir = copyFixtures(group)
  const ctx = new Context()
  await ctx.plugin(Logger)
  const fiber = await ctx.plugin(Loader)
  await ctx.loader.create({
    name: '@cordisjs/plugin-include',
    config: {
      path: pathToFileURL(resolve(dir, configFile)).href,
    },
  })
  await waitFor(() => ctx.get('hmr'), 5000)
  return { ctx, fiber }
}

interface Gate {
  acquired: number
  applies: number
  fibers: Fiber[]
  hold?: Promise<void>
  entered?: () => void
  release?: () => void
  timer?: NodeJS.Timeout
}

function configTree(ctx: Context) {
  for (const entry of ctx.loader.entries()) {
    if (entry.subtree) return entry.subtree
  }
  throw new Error('config tree missing')
}

function findEntry(ctx: Context, id: string) {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.id === id) return entry
  }
  const ids = [...ctx.loader.entries()].map(entry => entry.options.id)
  throw new Error(`entry ${id} not found in ${ids.join(', ')}`)
}

function installGate(): Gate {
  const gate: Gate = { acquired: 0, applies: 0, fibers: [] }
  ;(globalThis as any).__hmrGate = gate
  return gate
}

function arm(gate: Gate, timeout = 8000) {
  let release!: () => void
  let entered!: () => void
  gate.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  gate.release = release
  const inside = new Promise<void>((resolve, reject) => {
    gate.timer = setTimeout(() => reject(new Error('unload barrier timed out')), timeout)
    entered = () => {
      clearTimeout(gate.timer)
      resolve()
    }
  })
  gate.entered = entered
  return inside
}

// Also called when a test fails between `arm()` and awaiting its barrier,
// whose timer would otherwise reject with nobody to handle it.
function disarm(gate: Gate | undefined) {
  if (!gate) return
  clearTimeout(gate.timer)
  gate.hold = undefined
  gate.entered = undefined
  gate.release?.()
}

function liveUids(gate: Gate) {
  return gate.fibers.filter(fiber => fiber.uid !== null).map(fiber => fiber.uid)
}

function dropCached(ctx: Context, name: string) {
  const cache = ctx.loader.internal?.loadCache
  if (!cache) return
  for (const key of [...Map.prototype.keys.call(cache) as Iterable<string>]) {
    if (key.includes(name)) Map.prototype.delete.call(cache, key)
  }
}

describe('HMR', () => {
  beforeAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  describe('nested entry tree', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const treeDep = fixture('nested', 'tree-dep.ts')

    beforeAll(async () => {
      const result = await createContext('nested', 'cordis-nested.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      treeDep.restore()
      await ctx.hmr.reconcile({ files: [treeDep.path] })
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should instantiate a nested entry exactly once when its host reloads too', async () => {
      const stats = (globalThis as any).__hmrTest
      await waitFor(() => ctx.bail('hmr-test/get-nested') === 'tree-v1')
      const applied = stats.nestedApplied

      // one change, two entries in the batch: the tree host and the entry
      // nested two fiber levels below it
      treeDep.modify(c => c.replace("version = 'tree-v1'", "version = 'tree-v2'"))
      const result = await ctx.hmr.reconcile({ files: [treeDep.path] })
      expect(result.settledFibers.map(fiber => fiber.state)).to.not.include(FiberState.FAILED)

      expect(ctx.bail('hmr-test/get-tree')).to.equal('tree-v2')
      // the host rebuilds its subtree; reloading the nested entry separately
      // would apply it a second time
      expect(stats.nestedApplied - applied).to.equal(1)
    }, 15000)

    it('should skip a nested entry whose host has not started unloading', async () => {
      const stats = (globalThis as any).__hmrTest
      await waitFor(() => ctx.bail('hmr-test/get-nested') === 'tree-v1')

      // batch 1: the host registers its subtree and then stalls inside init,
      // which defers its own unload and keeps the intermediate fiber active
      stats.stallTreeInit = 3000
      treeDep.modify(c => c.replace("version = 'tree-v1'", "version = 'tree-v2'"))
      const first = ctx.hmr.reconcile({ files: [treeDep.path] })
      await waitFor(() => ctx.bail('hmr-test/get-nested') === 'tree-v2')
      const applied = stats.nestedApplied

      // batch 2 arrives while the host is still stalled, so the nested entry's
      // direct parent is very much alive; only walking up to the host itself
      // reveals that the subtree is going away. Batch 1 waits for the host to
      // finish initializing, so batch 2 is queued behind it; this pins that
      // the queue keeps the two from overlapping.
      stats.stallTreeInit = 0
      treeDep.write(treeDep.original.replace("version = 'tree-v1'", "version = 'tree-v3'"))
      const results = await Promise.all([first, ctx.hmr.reconcile({ files: [treeDep.path] })])
      expect(results.flatMap(result => result.settledFibers).map(fiber => fiber.state)).to.not.include(FiberState.FAILED)

      expect(ctx.bail('hmr-test/get-tree')).to.equal('tree-v3')

      expect(ctx.bail('hmr-test/get-nested')).to.equal('tree-v3')
      expect(stats.nestedApplied - applied).to.equal(1)
    }, 30000)
  })

  describe('resource handoff on reload', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const drainDep = fixture('drain', 'drain-dep.ts')

    beforeAll(async () => {
      const result = await createContext('drain', 'cordis-drain.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      drainDep.restore()
      await ctx.hmr.reconcile({ files: [drainDep.path] })
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 500))
    })

    it('should not start the new instance before the old one released', async () => {
      const stats = (globalThis as any).__hmrTest
      await waitFor(() => ctx.bail('hmr-test/get-slow') === 'drain-v1')
      const overlaps = stats.slowOverlaps ?? 0

      drainDep.modify(c => c.replace("version = 'drain-v1'", "version = 'drain-v2'"))
      await ctx.hmr.reconcile({ files: [drainDep.path] })
      expect(ctx.bail('hmr-test/get-slow')).to.equal('drain-v2')

      expect((stats.slowOverlaps ?? 0) - overlaps).to.equal(0)
    }, 15000)

    it('should not delay an unrelated plugin behind a slow one', async () => {
      const stats = (globalThis as any).__hmrTest
      await waitFor(() => ctx.bail('hmr-test/get-fast') === 'drain-v1')

      drainDep.modify(c => c.replace("version = 'drain-v1'", "version = 'drain-v3'"))
      const reloaded = ctx.hmr.reconcile({ files: [drainDep.path] })
      await waitFor(() => ctx.bail('hmr-test/get-fast') === 'drain-v3')
      const fastAppliedAt = stats.fastAppliedAt
      await reloaded

      // plugin-fast must come back inside the window during which plugin-slow
      // is still draining: waiting for the whole batch to drain would push it
      // past `slowReleasedAt`.
      expect(fastAppliedAt).to.be.greaterThanOrEqual(stats.slowDisposeStartedAt)
      expect(fastAppliedAt).to.be.lessThan(stats.slowReleasedAt)
    }, 15000)
  })

  describe('plugin with multiple entries', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const pluginMulti = fixture('multi', 'plugin-multi.ts')

    beforeAll(async () => {
      const result = await createContext('multi', 'cordis-multi-entry.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      pluginMulti.restore()
      await ctx.hmr.reconcile({ files: [pluginMulti.path] })
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should rebuild every fiber, each keeping its own config', async () => {
      const stats = (globalThis as any).__hmrTest
      // both entries resolve to the same file, so one runtime holds two fibers
      await waitFor(() => ctx.bail('hmr-test/get-multi', 'a') === 'multi-v1')
      expect(ctx.bail('hmr-test/get-multi', 'b')).to.equal('multi-v1')

      stats.multiApplies = []
      pluginMulti.modify(c => c.replace("version = 'multi-v1'", "version = 'multi-v2'"))
      const result = await ctx.hmr.reconcile({ files: [pluginMulti.path] })

      expect(result.settledFibers).to.have.length(2)
      // exactly one new instance per entry, each with its own config intact
      expect([...stats.multiApplies].sort()).to.deep.equal(['a:multi-v2', 'b:multi-v2'])
    }, 15000)
  })

  describe('entry changed during unload', () => {
    const plugin = fixture('disabled', 'plugin-disabled-hmr.ts')
    let ctx: Context
    let root: Fiber
    let gate: Gate

    beforeAll(async () => {
      gate = installGate()
      const started = await createContext('disabled', 'cordis-disabled.yml')
      ctx = started.ctx
      root = started.fiber
      await waitFor(() => gate.acquired === 1 && ctx.bail('hmr-test/get-value') === 'initial')
    }, 20000)

    beforeEach(() => {
      for (let i = gate.fibers.length - 1; i >= 0; i--) {
        if (gate.fibers[i].uid === null) gate.fibers.splice(i, 1)
      }
      gate.acquired = gate.fibers.length
      gate.applies = 0
    })

    afterEach(async () => {
      // The next reload must not stop on this test's barrier.
      disarm(gate)
      let entry: ReturnType<typeof findEntry> | undefined
      try {
        entry = findEntry(ctx, 'live')
      } catch {
        entry = undefined
      }
      plugin.restore()
      const reloaded = ctx.hmr.reconcile({ files: [plugin.path] })
      await reloaded
      if (!entry) {
        // The reload above does not reimport a plugin that is no longer an entry.
        dropCached(ctx, 'plugin-disabled-hmr')
        await configTree(ctx).create({ id: 'live', name: './plugin-disabled-hmr' })
      } else if (entry.disabled) {
        await entry.update({ disabled: false })
      }
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'initial')
    }, 20000)

    afterAll(async () => {
      disarm(gate)
      delete (globalThis as any).__hmrGate
      await root?.dispose()
    })

    it('does not rebuild an entry disabled during unload', async () => {
      const entry = findEntry(ctx, 'live')
      const previous = entry.innerFiber!
      const inside = arm(gate)
      plugin.modify(content => content.replace("value = 'initial'", "value = 'should-not-live'"))
      const reloaded = ctx.hmr.reconcile({ files: [plugin.path] })
      await inside

      await entry.update({ disabled: true })
      gate.release?.()
      await reloaded

      expect(entry.disabled).to.equal(true)
      expect(entry.innerFiber).to.equal(previous)
      expect(previous.uid).to.equal(null)
      expect(ctx.bail('hmr-test/get-value')).to.equal(undefined)
      expect(gate.applies).to.equal(0)
      expect(liveUids(gate)).to.deep.equal([])
    }, 15000)

    it('does not rebuild an entry removed during unload', async () => {
      const entry = findEntry(ctx, 'live')
      const previous = entry.innerFiber!
      const inside = arm(gate)
      plugin.modify(content => content.replace("value = 'initial'", "value = 'removed-value'"))
      const reloaded = ctx.hmr.reconcile({ files: [plugin.path] })
      await inside

      entry.parent.remove(entry.options.id)
      // removal does not set `disabled`
      expect(entry.disabled).to.equal(false)
      gate.release?.()
      await reloaded

      expect(entry.innerFiber).to.equal(previous)
      expect(previous.uid).to.equal(null)
      expect(ctx.bail('hmr-test/get-value')).to.equal(undefined)
      expect(gate.applies).to.equal(0)
      expect(liveUids(gate)).to.deep.equal([])
    }, 15000)

    it('waits for a second re-enable init before deciding whether to rebuild', async () => {
      const entry = findEntry(ctx, 'live')
      const previous = entry.innerFiber!
      const inside = arm(gate)
      plugin.modify(content => content.replace("value = 'initial'", "value = 'second-init'"))
      const reloaded = ctx.hmr.reconcile({ files: [plugin.path] })
      await inside

      let releaseFirst!: () => void
      let releaseSecond!: () => void
      const firstHold = new Promise<void>((resolve) => { releaseFirst = resolve })
      const secondHold = new Promise<void>((resolve) => { releaseSecond = resolve })
      let patches = 0
      let firstInstalled: Fiber | undefined
      let updating: Promise<void> | undefined
      let reenabled: Promise<void> | undefined
      const stop = ctx.on('loader/patch-context', async (patched, next) => {
        if (patched !== entry) return next()
        if (++patches === 1) {
          await firstHold
        } else if (patches === 2) {
          await secondHold
        }
        return next()
      })
      try {
        await entry.update({ disabled: true })
        updating = entry.update({ disabled: false })
        await waitFor(() => patches === 1)
        // Joining through init() observes its completion before the outer update().
        reenabled = entry.init().then(() => {
          firstInstalled = entry.innerFiber
          void entry.update({ disabled: true })
          return entry.update({ disabled: false })
        })

        gate.release?.()
        // HMR was already awaiting this unload before the test joins it.
        await previous.await()
        releaseFirst()
        await waitFor(() => patches === 2)
        releaseSecond()
        await Promise.all([updating, reenabled, reloaded])
        await firstInstalled?.await()
        await ctx.loader.await()

        expect(patches).to.equal(2)
        expect(ctx.bail('hmr-test/get-value')).to.equal('second-init')
        // one per re-enable, none from HMR
        expect(gate.applies).to.equal(2)
        expect(liveUids(gate)).to.deep.equal([entry.innerFiber!.uid])
      } finally {
        releaseFirst()
        releaseSecond()
        disarm(gate)
        stop()
        await Promise.allSettled([updating, reenabled, reloaded])
        // Remove any duplicate produced by a failing implementation before cleanup reloads.
        const current = entry.innerFiber && Object.getPrototypeOf(entry.innerFiber)
        await Promise.all(gate.fibers.filter(fiber => fiber !== current).map(fiber => fiber.dispose()))
      }
    }, 15000)

    it('rebuilds a child of an active host that reused the plugin', async () => {
      const entry = findEntry(ctx, 'live')
      const previous = entry.innerFiber!
      await configTree(ctx).create({ id: 'host', name: './plugin-host' })
      const host = findEntry(ctx, 'host')
      const hostRoot = host.innerFiber!
      await waitFor(() => liveUids(gate).length === 2)
      const appliesBefore = gate.applies

      const inside = arm(gate)
      plugin.modify(content => content.replace("value = 'initial'", "value = 'from-host'"))
      const reloaded = ctx.hmr.reconcile({ files: [plugin.path] })
      await inside
      await waitFor(() => gate.acquired === 0)
      gate.release?.()
      await reloaded
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'from-host')

      // both the entry root and the child of the host are rebuilt
      expect(gate.applies - appliesBefore).to.equal(2)
      expect(entry.innerFiber).to.not.equal(previous)
      expect(liveUids(gate)).to.have.length(2)
      // rebuilding the child does not take over the host's entry root
      expect(host.innerFiber).to.equal(hostRoot)

      await host.update({ disabled: true })
      await hostRoot.await()
      expect(hostRoot.uid).to.equal(null)
      expect(liveUids(gate)).to.deep.equal([entry.innerFiber!.uid])
    }, 15000)

    it('skips a child whose host is replaced during unload', async () => {
      const warnings: string[] = []
      const dispose = ctx.logger.exporter({
        export(message) {
          if (message.type === 'warn') warnings.push(message.args[0])
        },
      })
      let host: ReturnType<typeof findEntry> | undefined
      try {
        await configTree(ctx).create({ id: 'host', name: './plugin-host' })
        host = findEntry(ctx, 'host')
        const hostRoot = host.innerFiber!
        await waitFor(() => liveUids(gate).length === 2)

        const inside = arm(gate)
        plugin.modify(content => content.replace("value = 'initial'", "value = 'host-replaced'"))
        const reloaded = ctx.hmr.reconcile({ files: [plugin.path] })
        await inside
        await waitFor(() => gate.acquired === 0)

        await host.update({ disabled: true })
        await host.update({ disabled: false })
        expect(hostRoot.uid).to.equal(null)
        expect(host.innerFiber?.uid ?? null).to.not.equal(null)

        gate.release?.()
        await reloaded

        // the stale child would be rebuilt under the disposed host and throw
        expect(warnings.filter(w => w.includes('failed to reload'))).to.deep.equal([])
        // the entry root and the child mounted by the new host
        expect(liveUids(gate).length).to.equal(2)
      } finally {
        dispose()
        host?.parent.remove(host.options.id)
      }
    }, 15000)
  })
})
