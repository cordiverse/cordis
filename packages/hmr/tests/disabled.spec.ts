import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Logger from '@cordisjs/plugin-logger-console'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))

interface Gate {
  acquired: number
  applies: number
  fibers: Fiber[]
  hold?: Promise<void>
  entered?: () => void
  release?: () => void
}

function backupFile(filename: string) {
  const path = resolve(testDir, filename)
  const original = readFileSync(path, 'utf-8')
  return {
    path,
    original,
    modify(replaceFn: (content: string) => string) {
      writeFileSync(path, replaceFn(original))
    },
    restore() {
      writeFileSync(path, original)
    },
  }
}

function waitFor(condFn: () => boolean | any, timeout = 8000, interval = 50): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const check = setInterval(() => {
      if (condFn()) {
        clearInterval(check)
        resolve()
      }
    }, interval)
    setTimeout(() => {
      clearInterval(check)
      reject(new Error('waitFor timed out'))
    }, timeout)
  })
}

function waitForEvent(ctx: Context, event: string, timeout = 8000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const dispose = ctx.on(event as any, (...args: any[]) => {
      dispose()
      resolve(args)
    })
    setTimeout(() => {
      dispose()
      reject(new Error(`waitForEvent(${event}) timed out`))
    }, timeout)
  })
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
    const timer = setTimeout(() => reject(new Error('unload barrier timed out')), timeout)
    entered = () => {
      clearTimeout(timer)
      resolve()
    }
  })
  gate.entered = entered
  return inside
}

function disarm(gate: Gate | undefined) {
  if (!gate) return
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

async function createContext(configFile: string): Promise<{ ctx: Context; fiber: Fiber<Context> }> {
  const ctx = new Context()
  await ctx.plugin(Logger)
  const fiber = await ctx.plugin(Loader)
  await ctx.loader.create({
    name: '@cordisjs/plugin-include',
    config: {
      path: pathToFileURL(resolve(testDir, configFile)).href,
    },
  })
  await waitFor(() => ctx.hmr, 5000)
  await new Promise(r => setTimeout(r, 500))
  return { ctx, fiber }
}

describe('HMR disabled entry', () => {
  const plugin = backupFile('plugin-disabled-hmr.ts')
  const config = backupFile('cordis-disabled.yml')
  let ctx: Context
  let root: Fiber
  let gate: Gate

  beforeAll(async () => {
    plugin.restore()
    gate = installGate()
    const started = await createContext('cordis-disabled.yml')
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
    const reloaded = waitForEvent(ctx, 'hmr/reload')
    plugin.restore()
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
    plugin.restore()
    await root?.dispose()
    config.restore()
  })

  it('reloads an entry that stays enabled', async () => {
    const entry = findEntry(ctx, 'live')
    const previous = entry.fiber!
    const inside = arm(gate)
    plugin.modify(content => content.replace("value = 'initial'", "value = 'modified'"))
    await inside

    expect(previous.uid).to.equal(null)
    expect(entry.disabled).to.equal(false)
    expect(gate.acquired).to.equal(0)
    expect(ctx.bail('hmr-test/get-value') ?? null).to.equal(null)

    gate.release?.()
    await waitFor(() => ctx.bail('hmr-test/get-value') === 'modified')

    expect({
      event: ctx.bail('hmr-test/get-value'),
      sameFiber: entry.fiber === previous,
      uid: entry.fiber?.uid ?? null,
      previousUid: previous.uid,
      acquired: gate.acquired,
      applies: gate.applies,
      live: liveUids(gate),
    }).to.deep.equal({
      event: 'modified',
      sameFiber: false,
      uid: entry.fiber?.uid,
      previousUid: null,
      acquired: 1,
      applies: 1,
      live: [entry.fiber?.uid],
    })
  }, 15000)

  it('does not rebuild an entry disabled during unload', async () => {
    const entry = findEntry(ctx, 'live')
    const previous = entry.fiber!
    expect(entry.disabled).to.equal(false)
    expect(previous.uid).to.not.equal(null)

    const inside = arm(gate)
    // Join only. hmr/reload is emitted whether or not stage 3 installs a fiber.
    const reloaded = waitForEvent(ctx, 'hmr/reload')
    plugin.modify(content => content.replace("value = 'initial'", "value = 'should-not-live'"))
    await inside

    expect(previous.uid).to.equal(null)
    expect(gate.acquired).to.equal(0)
    expect(ctx.bail('hmr-test/get-value') ?? null).to.equal(null)
    expect(liveUids(gate)).to.deep.equal([])

    await entry.update({ disabled: true })

    expect({
      disabled: entry.disabled,
      uid: previous.uid,
      event: ctx.bail('hmr-test/get-value') ?? null,
      acquired: gate.acquired,
      applies: gate.applies,
      live: liveUids(gate),
    }).to.deep.equal({
      disabled: true,
      uid: null,
      event: null,
      acquired: 0,
      applies: 0,
      live: [],
    })

    gate.release?.()
    await reloaded

    expect({
      disabled: entry.disabled,
      sameFiber: entry.fiber === previous,
      uid: entry.fiber?.uid ?? null,
      event: ctx.bail('hmr-test/get-value') ?? null,
      acquired: gate.acquired,
      applies: gate.applies,
      live: liveUids(gate),
    }).to.deep.equal({
      disabled: true,
      sameFiber: true,
      uid: null,
      event: null,
      acquired: 0,
      applies: 0,
      live: [],
    })
  }, 15000)

  it('does not install a second fiber when re-enabled during unload', async () => {
    const entry = findEntry(ctx, 'live')
    const previous = entry.fiber!
    const inside = arm(gate)
    const reloaded = waitForEvent(ctx, 'hmr/reload')
    plugin.modify(content => content.replace("value = 'initial'", "value = 'reenabled'"))
    await inside

    await entry.update({ disabled: true })
    expect({
      disabled: entry.disabled,
      uid: previous.uid,
      event: ctx.bail('hmr-test/get-value') ?? null,
      acquired: gate.acquired,
    }).to.deep.equal({
      disabled: true,
      uid: null,
      event: null,
      acquired: 0,
    })

    await entry.update({ disabled: false })
    await waitFor(() => ctx.bail('hmr-test/get-value') === 'reenabled')

    const installed = entry.fiber
    expect({
      disabled: entry.disabled,
      sameAsUnloaded: installed === previous,
      uid: installed?.uid ?? null,
      event: ctx.bail('hmr-test/get-value'),
      acquired: gate.acquired,
      applies: gate.applies,
      live: liveUids(gate),
    }).to.deep.equal({
      disabled: false,
      sameAsUnloaded: false,
      uid: installed?.uid,
      event: 'reenabled',
      acquired: 1,
      applies: 1,
      live: [installed?.uid],
    })

    gate.release?.()
    await reloaded

    expect({
      sameFiber: entry.fiber === installed,
      uid: entry.fiber?.uid ?? null,
      event: ctx.bail('hmr-test/get-value'),
      acquired: gate.acquired,
      applies: gate.applies,
      live: liveUids(gate),
    }).to.deep.equal({
      sameFiber: true,
      uid: installed?.uid,
      event: 'reenabled',
      acquired: 1,
      applies: 1,
      live: [installed?.uid],
    })
  }, 15000)

  it('does not rebuild an entry removed during unload', async () => {
    const entry = findEntry(ctx, 'live')
    const previous = entry.fiber!
    const inside = arm(gate)
    const reloaded = waitForEvent(ctx, 'hmr/reload')
    plugin.modify(content => content.replace("value = 'initial'", "value = 'removed-value'"))
    await inside

    entry.parent.remove(entry.options.id)

    expect(entry.parent.tree.store[entry.options.id] === entry).to.equal(false)
    expect(previous.uid).to.equal(null)
    expect(ctx.bail('hmr-test/get-value') ?? null).to.equal(null)
    expect(gate.acquired).to.equal(0)
    expect(entry.disabled).to.equal(false)

    gate.release?.()
    await reloaded

    expect({
      stored: entry.parent.tree.store[entry.options.id] === entry,
      sameFiber: entry.fiber === previous,
      uid: entry.fiber?.uid ?? null,
      event: ctx.bail('hmr-test/get-value') ?? null,
      acquired: gate.acquired,
      applies: gate.applies,
      live: liveUids(gate),
    }).to.deep.equal({
      stored: false,
      sameFiber: true,
      uid: null,
      event: null,
      acquired: 0,
      applies: 0,
      live: [],
    })
  }, 15000)

  it('does not plugin again while re-enable init is still in patch-context', async () => {
    const entry = findEntry(ctx, 'live')
    const previous = entry.fiber!
    const inside = arm(gate)
    let reloadedEarly = false
    const reloaded = waitForEvent(ctx, 'hmr/reload').then((args) => {
      reloadedEarly = true
      return args
    })
    plugin.modify(content => content.replace("value = 'initial'", "value = 'mid-init'"))
    await inside

    let releaseInit!: () => void
    let markInit!: () => void
    const holdInit = new Promise<void>((resolve) => {
      releaseInit = resolve
    })
    const initInside = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('init barrier timed out')), 8000)
      markInit = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    const stop = ctx.on('loader/patch-context', async (patched, next) => {
      if (patched.options.id !== 'live' || !patched._initTask) return next()
      markInit()
      await holdInit
      return next()
    })
    try {
      const updating = entry.update({ disabled: true }).then(() => entry.update({ disabled: false }))
      await initInside

      expect(entry._initTask).to.not.equal(undefined)
      expect(entry.fiber === previous).to.equal(true)
      expect(previous.uid).to.equal(null)
      expect(gate.applies).to.equal(0)

      gate.release?.()
      await new Promise(r => setTimeout(r, 50))
      expect({
        reloadedEarly,
        applies: gate.applies,
        sameFiber: entry.fiber === previous,
      }).to.deep.equal({
        reloadedEarly: false,
        applies: 0,
        sameFiber: true,
      })

      releaseInit()
      await updating
      await reloaded
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'mid-init')
      expect({
        event: ctx.bail('hmr-test/get-value'),
        applies: gate.applies,
        acquired: gate.acquired,
        live: liveUids(gate),
        sameAsUnloaded: entry.fiber === previous,
        uid: entry.fiber?.uid ?? null,
      }).to.deep.equal({
        event: 'mid-init',
        applies: 1,
        acquired: 1,
        live: [entry.fiber?.uid],
        sameAsUnloaded: false,
        uid: entry.fiber?.uid,
      })
    } finally {
      releaseInit()
      stop()
    }
  }, 15000)

  it('rebuilds a child of an active host that reused the plugin', async () => {
    const entry = findEntry(ctx, 'live')
    const previous = entry.fiber!
    await configTree(ctx).create({ id: 'host', name: './plugin-host' })
    const host = findEntry(ctx, 'host')
    const hostRoot = host.fiber!
    await waitFor(() => liveUids(gate).length === 2)
    const appliesBefore = gate.applies

    const inside = arm(gate)
    const reloaded = waitForEvent(ctx, 'hmr/reload')
    plugin.modify(content => content.replace("value = 'initial'", "value = 'from-host'"))
    await inside
    await waitFor(() => gate.acquired === 0)

    expect(hostRoot.uid).to.not.equal(null)

    gate.release?.()
    await reloaded
    await waitFor(() => ctx.bail('hmr-test/get-value') === 'from-host')

    expect({
      event: ctx.bail('hmr-test/get-value'),
      hostUid: hostRoot.uid,
      applies: gate.applies - appliesBefore,
      live: liveUids(gate).length,
      entryRebuilt: entry.fiber !== previous,
    }).to.deep.equal({
      event: 'from-host',
      hostUid: hostRoot.uid,
      applies: 2,
      live: 2,
      entryRebuilt: true,
    })
    expect(entry.fiber?.uid ?? null).to.not.equal(null)
  }, 15000)
})
