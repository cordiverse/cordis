import { Context, Fiber, Message } from 'cordis'
import Loader, { ModuleLoader } from '@cordisjs/plugin-loader'
import Logger from '@cordisjs/plugin-logger-console'
import type { Include } from '@cordisjs/plugin-include'
import type {} from '@cordisjs/plugin-fs-watcher'
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { expect, describe, it, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Hmr from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))

// Helper: read and backup a file, returning restore function
function backupFile(filename: string) {
  const path = resolve(testDir, filename)
  const original = readFileSync(path, 'utf-8')
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
        resolve()
      }
    }, interval)
    setTimeout(() => {
      clearInterval(check)
      reject(new Error('waitFor timed out'))
    }, timeout)
  })
}

// Helper: wait for an event to fire
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
  await waitFor(() => ctx.hmr && ctx.fsWatcher, 5000)
  await new Promise(r => setTimeout(r, 500))
  return { ctx, fiber }
}

interface Gate {
  acquired: number
  applies: number
  fibers: Fiber[]
  hold?: Promise<void>
  entered?: () => void
  release?: () => void
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

// Settle time after file restore, to let any triggered HMR finish
const SETTLE_MS = 500

describe('HMR', () => {
  // ===== Basic single plugin tests =====
  describe('basic single plugin', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const plugin = backupFile('plugin.ts')

    beforeAll(async () => {
      plugin.restore()
      const result = await createContext('cordis.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      plugin.restore()
      // Wait for any HMR triggered by restore to settle
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should load plugin and respond to events', () => {
      const value = ctx.bail('hmr-test/get-value')
      expect(value).to.equal('initial')
    })

    it('should reload plugin when file changes', async () => {

      let disposed = false
      ctx.on('hmr-test/disposed', () => { disposed = true })

      plugin.modify(c => c.replace("value = 'initial'", "value = 'modified'"))

      await waitFor(() => ctx.bail('hmr-test/get-value') === 'modified')

      expect(ctx.bail('hmr-test/get-value')).to.equal('modified')
      expect(disposed).to.be.true
    }, 10000)

    it('should handle reverting file back to original', async () => {

      // First change it
      plugin.modify(c => c.replace("value = 'initial'", "value = 'to-revert'"))
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'to-revert')

      // Then revert
      plugin.restore()
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'initial')

      expect(ctx.bail('hmr-test/get-value')).to.equal('initial')
    }, 10000)

    it('should emit hmr/reload event on reload', async () => {

      const reloadPromise = waitForEvent(ctx, 'hmr/reload')
      plugin.modify(c => c.replace("value = 'initial'", "value = 'event-test'"))

      const [result] = await reloadPromise
      expect(result.replaced).to.have.length(1)
      expect(result.failed).to.deep.equal([])
      expect(result.aborted).to.be.undefined
    }, 10000)

    it('should properly dispose old plugin effects on reload', async () => {

      let disposeCount = 0
      ctx.on('hmr-test/disposed', () => { disposeCount++ })

      plugin.modify(c => c.replace("value = 'initial'", "value = 'dispose-test-1'"))
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'dispose-test-1')

      const countAfterFirst = disposeCount

      plugin.write(plugin.original.replace("value = 'initial'", "value = 'dispose-test-2'"))
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'dispose-test-2')

      expect(disposeCount).to.be.greaterThan(countAfterFirst)
    }, 10000)
  })

  // ===== Multiple plugins =====
  describe('multiple plugins', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const pluginA = backupFile('plugin-a.ts')
    const pluginB = backupFile('plugin-b.ts')

    beforeAll(async () => {
      pluginA.restore()
      pluginB.restore()
      const result = await createContext('cordis-multi.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      pluginA.restore()
      pluginB.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should load multiple plugins', () => {
      expect(ctx.bail('hmr-test/get-a')).to.equal('alpha')
      expect(ctx.bail('hmr-test/get-b')).to.equal('beta')
    })

    it('should reload changed plugin without affecting others', async () => {

      // modify only plugin A
      pluginA.modify(c => c.replace("value = 'alpha'", "value = 'alpha-v2'"))

      await waitFor(() => ctx.bail('hmr-test/get-a') === 'alpha-v2')

      expect(ctx.bail('hmr-test/get-a')).to.equal('alpha-v2')
      // plugin B should remain unchanged
      expect(ctx.bail('hmr-test/get-b')).to.equal('beta')
    }, 10000)

    it('should handle simultaneous changes to both plugins', async () => {

      pluginA.modify(c => c.replace("value = 'alpha'", "value = 'alpha-v3'"))
      pluginB.modify(c => c.replace("value = 'beta'", "value = 'beta-v3'"))

      await waitFor(() =>
        ctx.bail('hmr-test/get-a') === 'alpha-v3' &&
        ctx.bail('hmr-test/get-b') === 'beta-v3',
      )

      expect(ctx.bail('hmr-test/get-a')).to.equal('alpha-v3')
      expect(ctx.bail('hmr-test/get-b')).to.equal('beta-v3')
    }, 10000)
  })

  // ===== Dependency chain =====
  describe('dependency chain', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const dep = backupFile('dep.ts')
    const pluginDep = backupFile('plugin-dep.ts')

    beforeAll(async () => {
      dep.restore()
      pluginDep.restore()
      const result = await createContext('cordis-dep.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      dep.restore()
      pluginDep.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should load plugin with dependency', () => {
      expect(ctx.bail('hmr-test/get-dep')).to.equal('original-shared')
    })

    it('should reload plugin when its dependency changes', async () => {

      let disposed = false
      ctx.on('hmr-test/disposed-dep', () => { disposed = true })

      dep.modify(c => c.replace("sharedValue = 'original-shared'", "sharedValue = 'updated-shared'"))

      await waitFor(() => ctx.bail('hmr-test/get-dep') === 'updated-shared')

      expect(ctx.bail('hmr-test/get-dep')).to.equal('updated-shared')
      expect(disposed).to.be.true
    }, 10000)

    it('should reload plugin when plugin file itself changes', async () => {

      pluginDep.modify(c => c.replace(
        "ctx.on('hmr-test/get-dep', () => sharedValue)",
        "ctx.on('hmr-test/get-dep', () => 'prefix:' + sharedValue)",
      ))

      await waitFor(() => {
        const v = ctx.bail('hmr-test/get-dep')
        return typeof v === 'string' && v.startsWith('prefix:')
      })

      expect(ctx.bail('hmr-test/get-dep')).to.equal('prefix:original-shared')
    }, 10000)

    it('should not reload a sibling that only shares an unchanged module', async () => {
      const stats = (globalThis as any).__hmrTest
      expect(ctx.bail('hmr-test/get-dep-common')).to.equal('common')
      expect(ctx.bail('hmr-test/get-dep-sibling')).to.equal('common')
      const applied = stats.depSiblingApplied

      const reloaded: string[] = []
      const disposeExporter = ctx.logger.exporter({
        export(message) {
          if (message.args[0] === 'reload plugin at %C') reloaded.push(message.args[1])
        },
      })

      // dep.ts is imported by plugin-dep only; plugin-dep-sibling is listed
      // after it in the config and shares dep-common.ts with it
      dep.modify(c => c.replace("sharedValue = 'original-shared'", "sharedValue = 'updated-shared'"))
      await waitFor(() => ctx.bail('hmr-test/get-dep') === 'updated-shared')
      await new Promise(r => setTimeout(r, 500))
      disposeExporter()

      expect(reloaded).to.deep.equal(['plugin-dep.ts'])
      expect(stats.depSiblingApplied).to.equal(applied)
    }, 10000)
  })

  // ===== Import error rollback =====
  describe('import error rollback', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const pluginError = backupFile('plugin-error.ts')

    beforeAll(async () => {
      pluginError.restore()
      const result = await createContext('cordis-error.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      pluginError.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should load plugin normally', () => {
      expect(ctx.bail('hmr-test/get-error')).to.equal('ok')
    })

    it('should rollback on syntax error and keep old plugin working', async () => {

      pluginError.write(`
        import { Context } from 'cordis'
        export const name = 'plugin-error'
        export function apply(ctx: Context {{{ BROKEN
      `)

      await new Promise(r => setTimeout(r, 2000))

      // the old plugin should still be functional after rollback
      expect(ctx.bail('hmr-test/get-error')).to.equal('ok')
    }, 10000)

    it('should recover after fixing the error', async () => {

      pluginError.write(`
import { Context } from 'cordis'

export const name = 'plugin-error'

export let value = 'recovered'

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-error', () => value)
}
`)

      await waitFor(() => ctx.bail('hmr-test/get-error') === 'recovered')

      expect(ctx.bail('hmr-test/get-error')).to.equal('recovered')
    }, 10000)
  })

  // ===== Debounce =====
  describe('debounce', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const plugin = backupFile('plugin.ts')

    beforeAll(async () => {
      plugin.restore()
      const result = await createContext('cordis.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      plugin.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should batch rapid changes within debounce window', async () => {

      let reloadCount = 0
      ctx.on('hmr/reload', () => { reloadCount++ })

      // rapid changes within debounce window (50ms)
      plugin.modify(c => c.replace("value = 'initial'", "value = 'v1'"))
      await new Promise(r => setTimeout(r, 10))
      plugin.write(plugin.original.replace("value = 'initial'", "value = 'v2'"))
      await new Promise(r => setTimeout(r, 10))
      plugin.write(plugin.original.replace("value = 'initial'", "value = 'v3'"))

      await waitFor(() => ctx.bail('hmr-test/get-value') === 'v3')

      // debounce=50ms, writes are 10ms apart → should batch
      expect(reloadCount).to.be.lessThanOrEqual(2)
    }, 10000)
  })

  // ===== Config file reload =====
  describe('config file changes', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const configPath = resolve(testDir, 'cordis.yml')
    const configBackup = readFileSync(configPath, 'utf-8')
    const plugin = backupFile('plugin.ts')

    beforeAll(async () => {
      plugin.restore()
      writeFileSync(configPath, configBackup)
      const result = await createContext('cordis.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      plugin.restore()
      writeFileSync(configPath, configBackup)
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should handle config file update to disable plugin', async () => {

      expect(ctx.bail('hmr-test/get-value')).to.equal('initial')

      // Disable the test plugin via config
      const disabledConfig = configBackup.replace(
        '- id: test\n  name: ./plugin',
        '- id: test\n  name: ./plugin\n  disabled: true',
      )
      writeFileSync(configPath, disabledConfig)

      // wait for config reload
      await new Promise(r => setTimeout(r, 2000))

      // plugin should be disabled
      const value = ctx.bail('hmr-test/get-value')
      expect(value).to.not.equal('initial')
    }, 10000)
  })

  // ===== Config file atomic writes =====
  describe('config file atomic writes', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const configPath = resolve(testDir, 'cordis-atomic.yml')
    const messages: Message[] = []

    const configWith = (value: string) => `- id: hmr
  name: '@cordisjs/plugin-hmr'
  config:
    debounce: 50
- id: fs-watcher
  name: '@cordisjs/plugin-fs-watcher'
  config:
    root:
      - .
- id: cfg
  name: ./plugin-config
  config:
    value: ${value}
`

    beforeAll(async () => {
      writeFileSync(configPath, configWith('v0'))
      const result = await createContext('cordis-atomic.yml')
      ctx = result.ctx
      fiber = result.fiber
      ctx.logger.exporter({ export: message => messages.push(message) })
    }, 10000)

    afterAll(async () => {
      await fiber?.dispose()
      try { unlinkSync(configPath) } catch {}
    })

    function include() {
      for (const entry of ctx.loader.entries()) {
        if ((entry.subtree as Include | undefined)?.filename === configPath) return entry.subtree as Include
      }
      throw new Error('include not found')
    }

    it('keeps watching the file across its own rename-based writes', async () => {
      const inc = include()
      const id = ctx.loader.store[inc.ctx.fiber.entry!.options.id]!.id
      const refresh = vi.spyOn(inc, 'refresh')

      // two runtime writes → two temp-file-plus-rename cycles on the config
      for (const value of ['v1', 'v2']) {
        await ctx.loader.update(`${id}:cfg`, { config: { value } })
        await inc.refresh()
      }
      await waitFor(() => readFileSync(configPath, 'utf8').includes('value: v2'))
      await new Promise(r => setTimeout(r, 500))
      const settled = refresh.mock.calls.length

      // an external edit must still reach the tree through the watcher
      const external = configWith('v3')
      writeFileSync(configPath, external)
      await waitFor(() => ctx.bail('hmr-test/get-config')?.value === 'v3')

      // and our own writes must not have spawned a feedback loop
      await new Promise(r => setTimeout(r, 500))
      expect(refresh.mock.calls.length - settled).toBeLessThanOrEqual(3)
      expect(readFileSync(configPath, 'utf8')).toBe(external)
    }, 15000)

    it('logs instead of rejecting when the config file is unparsable', async () => {
      const before = messages.length
      writeFileSync(configPath, '- {\n')
      await waitFor(() => messages.slice(before).some(m => m.type === 'warn' && String(m.args[0]).includes('failed to parse')))

      // hmr is still alive and the tree kept its last good state
      expect(ctx.hmr).to.be.ok
      expect(ctx.bail('hmr-test/get-config')?.value).toBe('v3')

      writeFileSync(configPath, configWith('v4'))
      await waitFor(() => ctx.bail('hmr-test/get-config')?.value === 'v4')
    }, 15000)
  })

  // ===== Service plugin HMR =====
  describe('plugin with service registration', () => {
    let ctx: Context
    let fiber: Fiber<Context>

    const pluginPath = resolve(testDir, 'plugin-service.ts')
    const configPath = resolve(testDir, 'cordis-service.yml')

    const servicePluginContent = `
import { Context, Service } from 'cordis'

declare module 'cordis' {
  interface Context {
    myService: MyService
  }
}

class MyService extends Service {
  public data = 'service-v1'

  constructor(ctx: Context) {
    super(ctx, 'myService')
  }

  getValue() {
    return this.data
  }
}

export default MyService
`

    beforeAll(() => {
      writeFileSync(pluginPath, servicePluginContent)
      writeFileSync(configPath, `- id: hmr
  name: '@cordisjs/plugin-hmr'
  config:
    debounce: 50
- id: fs-watcher
  name: '@cordisjs/plugin-fs-watcher'
  config:
    root:
      - .
- id: my-service
  name: ./plugin-service
`)
    })

    afterEach(async () => {
      writeFileSync(pluginPath, servicePluginContent)
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
      try { unlinkSync(pluginPath) } catch {}
      try { unlinkSync(configPath) } catch {}
    })

    it('should load service plugin', async () => {
      const result = await createContext('cordis-service.yml')
      ctx = result.ctx
      fiber = result.fiber

      await waitFor(() => ctx.myService)
      expect(ctx.myService.getValue()).to.equal('service-v1')
    }, 10000)

    it('should reload service plugin on change', async () => {

      const content = readFileSync(pluginPath, 'utf-8')
      writeFileSync(pluginPath, content.replace("data = 'service-v1'", "data = 'service-v2'"))

      await waitFor(() => ctx.myService?.getValue() === 'service-v2')
      expect(ctx.myService.getValue()).to.equal('service-v2')
    }, 10000)
  })

  // ===== Fiber/entry re-association =====
  describe('fiber and entry re-association', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const plugin = backupFile('plugin.ts')

    beforeAll(async () => {
      plugin.restore()
      const result = await createContext('cordis.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      plugin.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should maintain entry association after reload', async () => {

      let entryId: string | undefined
      for (const entry of ctx.loader.entries()) {
        if (entry.options.name === './plugin') {
          entryId = entry.id
          break
        }
      }
      expect(entryId).to.be.ok

      plugin.modify(c => c.replace("value = 'initial'", "value = 'entry-test'"))
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'entry-test')

      let found = false
      for (const entry of ctx.loader.entries()) {
        if (entry.id === entryId) {
          found = true
          expect(entry.fiber).to.be.ok
          break
        }
      }
      expect(found).to.be.true
    }, 10000)
  })

  // ===== Rapid successive reloads =====
  describe('rapid successive reloads', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const plugin = backupFile('plugin.ts')

    beforeAll(async () => {
      plugin.restore()
      const result = await createContext('cordis.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterAll(async () => {
      plugin.restore()
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should handle many rapid reloads without crashing', async () => {

      for (let i = 0; i < 5; i++) {
        plugin.write(plugin.original.replace("value = 'initial'", `value = 'v${i}'`))
        await new Promise(r => setTimeout(r, 200))
      }

      await waitFor(() => ctx.bail('hmr-test/get-value') === 'v4')
      expect(ctx.bail('hmr-test/get-value')).to.equal('v4')
    }, 20000)
  })

  // ===== Event handler addition/removal =====
  describe('event handler changes', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const pluginEv = backupFile('plugin-event.ts')

    beforeAll(async () => {
      pluginEv.restore()
      const result = await createContext('cordis-event.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      pluginEv.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should register new event handlers after reload', async () => {

      expect(ctx.bail('hmr-test/get-event')).to.equal('initial')
      expect(ctx.bail('hmr-test/get-extra')).to.be.undefined

      pluginEv.write(`
import { Context } from 'cordis'

export const name = 'test-plugin-event'
export let value = 'with-extra'

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-event', () => value)
  ctx.on('hmr-test/get-extra', () => 'extra-data')
  ctx.effect(() => () => {
    ctx[Context.root].emit('hmr-test/disposed-event')
  })
}
`)

      await waitFor(() => ctx.bail('hmr-test/get-event') === 'with-extra')

      expect(ctx.bail('hmr-test/get-event')).to.equal('with-extra')
      expect(ctx.bail('hmr-test/get-extra')).to.equal('extra-data')
    }, 10000)

    it('should remove old event handlers after reload', async () => {

      // First add extra handler
      pluginEv.write(`
import { Context } from 'cordis'

export const name = 'test-plugin-event'
export let value = 'with-extra'

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-event', () => value)
  ctx.on('hmr-test/get-extra', () => 'extra-data')
  ctx.effect(() => () => {
    ctx[Context.root].emit('hmr-test/disposed-event')
  })
}
`)
      await waitFor(() => ctx.bail('hmr-test/get-extra') === 'extra-data')

      // Then restore original (no extra handler)
      pluginEv.restore()

      await waitFor(() => ctx.bail('hmr-test/get-event') === 'initial')

      expect(ctx.bail('hmr-test/get-event')).to.equal('initial')
      expect(ctx.bail('hmr-test/get-extra')).to.be.undefined
    }, 10000)
  })

  // ===== getLinked =====
  describe('getLinked', () => {
    let ctx: Context
    let fiber: Fiber<Context>

    beforeAll(async () => {
      const result = await createContext('cordis-dep.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should return linked dependencies for a loaded file', async () => {
      const pluginDepUrl = pathToFileURL(resolve(testDir, 'plugin-dep.ts')).href
      const linked = await ctx.hmr.getLinked(pluginDepUrl)

      expect(linked).to.be.an('array')
      const depUrl = pathToFileURL(resolve(testDir, 'dep.ts')).href
      expect(linked).to.include(depUrl)
    })

    it('should return empty array for unknown file', async () => {
      const linked = await ctx.hmr.getLinked(pathToFileURL('/nonexistent/file.ts').href)
      expect(linked).to.deep.equal([])
    })
  })

  // ===== Runtime error in apply =====
  describe('runtime error in plugin apply', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const pluginError = backupFile('plugin-error.ts')

    beforeAll(async () => {
      pluginError.restore()
      const result = await createContext('cordis-error.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      pluginError.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should handle apply error gracefully without crashing', async () => {

      expect(ctx.bail('hmr-test/get-error')).to.equal('ok')

      // Write a plugin that imports fine but throws in apply.
      // Note: apply errors are handled by the fiber system (internal/error),
      // not caught by HMR's try/catch. The old plugin is disposed and the
      // new one fails to initialize, so the handler goes away.
      pluginError.write(`
import { Context } from 'cordis'

export const name = 'plugin-error'

export let value = 'should-not-see'

export function apply(ctx: Context) {
  throw new Error('intentional apply error')
}
`)

      await new Promise(r => setTimeout(r, 2000))

      // HMR itself should still be alive and functional
      expect(ctx.hmr).to.be.ok

      // Recover by writing a valid plugin
      pluginError.write(`
import { Context } from 'cordis'

export const name = 'plugin-error'

export let value = 'recovered-from-error'

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-error', () => value)
}
`)

      await waitFor(() => ctx.bail('hmr-test/get-error') === 'recovered-from-error')
      expect(ctx.bail('hmr-test/get-error')).to.equal('recovered-from-error')
    }, 15000)
  })

  // ===== Stash clearing =====
  describe('stash management', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const plugin = backupFile('plugin.ts')

    beforeAll(async () => {
      plugin.restore()
      const result = await createContext('cordis.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      plugin.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should clear stashed files after successful reload', async () => {

      plugin.modify(c => c.replace("value = 'initial'", "value = 'stash-test'"))
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'stash-test')

      // After successful reload, changing the same file again should work
      plugin.write(plugin.original.replace("value = 'initial'", "value = 'stash-test-2'"))
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'stash-test-2')

      expect(ctx.bail('hmr-test/get-value')).to.equal('stash-test-2')
    }, 10000)
  })

  // ===== Nested entry trees =====
  describe('nested entry tree', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const treeDep = backupFile('tree-dep.ts')

    beforeAll(async () => {
      treeDep.restore()
      const result = await createContext('cordis-nested.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      treeDep.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should load the nested entry', async () => {
      await waitFor(() => ctx.bail('hmr-test/get-nested') === 'tree-v1')
      expect(ctx.bail('hmr-test/get-tree')).to.equal('tree-v1')
    }, 10000)

    it('should instantiate a nested entry exactly once when its host reloads too', async () => {
      const stats = (globalThis as any).__hmrTest
      await waitFor(() => ctx.bail('hmr-test/get-nested') === 'tree-v1')
      const applied = stats.nestedApplied

      // one change, two entries in the batch: the tree host and the entry
      // nested two fiber levels below it
      treeDep.modify(c => c.replace("version = 'tree-v1'", "version = 'tree-v2'"))
      await waitFor(() => ctx.bail('hmr-test/get-nested') === 'tree-v2')
      // let a duplicate instance, if any, finish being created and torn down
      await new Promise(r => setTimeout(r, 500))

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
      await waitFor(() => ctx.bail('hmr-test/get-nested') === 'tree-v2')
      const applied = stats.nestedApplied

      // batch 2 arrives while the host is still stalled, so the nested entry's
      // direct parent is very much alive; only walking up to the host itself
      // reveals that the subtree is going away. Batch 1 waits for the host to
      // finish initializing, so batch 2 is queued behind it; this pins that
      // the queue keeps the two from overlapping.
      stats.stallTreeInit = 0
      treeDep.write(treeDep.original.replace("version = 'tree-v1'", "version = 'tree-v3'"))
      // wait on the host, not the nested entry: the host only comes back after
      // its stall ends, and a duplicate nested instance would be applied
      // before that
      await waitFor(() => ctx.bail('hmr-test/get-tree') === 'tree-v3', 12000)
      await new Promise(r => setTimeout(r, 1000))

      expect(ctx.bail('hmr-test/get-nested')).to.equal('tree-v3')
      expect(stats.nestedApplied - applied).to.equal(1)
    }, 30000)
  })

  // ===== Resource handoff between old and new instances =====
  describe('resource handoff on reload', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const drainDep = backupFile('drain-dep.ts')

    beforeAll(async () => {
      drainDep.restore()
      const result = await createContext('cordis-drain.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      drainDep.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS + 500))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 500))
    })

    it('should load both plugins', async () => {
      await waitFor(() => ctx.bail('hmr-test/get-slow') === 'drain-v1')
      expect(ctx.bail('hmr-test/get-fast')).to.equal('drain-v1')
    }, 10000)

    it('should not start the new instance before the old one released', async () => {
      const stats = (globalThis as any).__hmrTest
      await waitFor(() => ctx.bail('hmr-test/get-slow') === 'drain-v1')
      const overlaps = stats.slowOverlaps ?? 0

      drainDep.modify(c => c.replace("version = 'drain-v1'", "version = 'drain-v2'"))
      await waitFor(() => ctx.bail('hmr-test/get-slow') === 'drain-v2')

      expect((stats.slowOverlaps ?? 0) - overlaps).to.equal(0)
    }, 15000)

    it('should not delay an unrelated plugin behind a slow one', async () => {
      const stats = (globalThis as any).__hmrTest
      await waitFor(() => ctx.bail('hmr-test/get-fast') === 'drain-v1')

      drainDep.modify(c => c.replace("version = 'drain-v1'", "version = 'drain-v3'"))
      await waitFor(() => ctx.bail('hmr-test/get-fast') === 'drain-v3')
      const fastAppliedAt = stats.fastAppliedAt
      await waitFor(() => ctx.bail('hmr-test/get-slow') === 'drain-v3')

      // plugin-fast must come back inside the window during which plugin-slow
      // is still draining: waiting for the whole batch to drain would push it
      // past `slowReleasedAt`.
      expect(fastAppliedAt).to.be.greaterThanOrEqual(stats.slowDisposeStartedAt)
      expect(fastAppliedAt).to.be.lessThan(stats.slowReleasedAt)
    }, 15000)
  })

  // ===== Malformed export =====
  describe('malformed export', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const pluginError = backupFile('plugin-error.ts')

    const countingPlugin = `
import { Context } from 'cordis'

const stats: any = ((globalThis as any).__hmrTest ??= {})

export const name = 'plugin-error'

export let value = 'counting'

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-error', () => value)
  ctx.effect(() => () => {
    stats.errorDisposed = (stats.errorDisposed ?? 0) + 1
  })
}
`

    beforeAll(async () => {
      pluginError.restore()
      const result = await createContext('cordis-error.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      pluginError.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should leave the running plugin untouched', async () => {
      const stats = (globalThis as any).__hmrTest
      pluginError.write(countingPlugin)
      await waitFor(() => ctx.bail('hmr-test/get-error') === 'counting')
      const disposed = stats.errorDisposed ?? 0

      // imports fine, but is not a plugin
      pluginError.write(`
export const name = 'plugin-error'
export const apply = 'not a function'
`)
      await new Promise(r => setTimeout(r, 2000))

      // validation happens before anything is unloaded, so the old instance
      // is never disposed and never rebuilt
      expect(ctx.bail('hmr-test/get-error')).to.equal('counting')
      expect((stats.errorDisposed ?? 0) - disposed).to.equal(0)
    }, 15000)

    it('should recover after fixing the export', async () => {
      pluginError.write(`
export const name = 'plugin-error'
export const apply = 'not a function'
`)
      await new Promise(r => setTimeout(r, 1000))

      pluginError.write(`
import { Context } from 'cordis'

export const name = 'plugin-error'

export let value = 'fixed-export'

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-error', () => value)
}
`)
      await waitFor(() => ctx.bail('hmr-test/get-error') === 'fixed-export')
      expect(ctx.bail('hmr-test/get-error')).to.equal('fixed-export')
    }, 15000)
  })

  // ===== One plugin, several entries =====
  describe('plugin with multiple entries', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const pluginMulti = backupFile('plugin-multi.ts')

    beforeAll(async () => {
      pluginMulti.restore()
      const result = await createContext('cordis-multi-entry.yml')
      ctx = result.ctx
      fiber = result.fiber
    }, 10000)

    afterEach(async () => {
      pluginMulti.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
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

      // count the per-plugin log line while the reload happens
      let reloadLogs = 0
      const disposeExporter = ctx.logger.exporter({
        export(message) {
          if (message.args[0] === 'reload plugin at %C') reloadLogs++
        },
      })

      stats.multiApplies = []
      pluginMulti.modify(c => c.replace("version = 'multi-v1'", "version = 'multi-v2'"))
      await waitFor(() =>
        ctx.bail('hmr-test/get-multi', 'a') === 'multi-v2' &&
        ctx.bail('hmr-test/get-multi', 'b') === 'multi-v2',
      )
      await new Promise(r => setTimeout(r, 500))
      disposeExporter()

      // exactly one new instance per entry, each with its own config intact
      expect([...stats.multiApplies].sort()).to.deep.equal(['a:multi-v2', 'b:multi-v2'])
      // two fibers, but the plugin is reported once
      expect(reloadLogs).to.equal(1)
    }, 15000)
  })

  // ===== Without loader internals =====
  describe('without loader internals', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const warnings: string[] = []
    const configPath = resolve(testDir, 'cordis-no-internal.yml')
    const configBackup = readFileSync(configPath, 'utf-8')
    const plugin = backupFile('plugin.ts')

    beforeAll(async () => {
      plugin.restore()
      writeFileSync(configPath, configBackup)
      ctx = new Context()
      await ctx.plugin(Logger)
      fiber = await ctx.plugin(Loader)
      ctx.logger.exporter({
        export(message) {
          if (message.type === 'warn') warnings.push(message.args[0])
        },
      })
      // HMR reads the internals itself; the loader does not share them.
      const spy = vi.spyOn(ModuleLoader, 'fromInternal').mockReturnValue(undefined)
      await ctx.plugin(Hmr)
      spy.mockRestore()
      await ctx.loader.create({
        name: '@cordisjs/plugin-include',
        config: {
          path: pathToFileURL(configPath).href,
        },
      })
      await waitFor(() => ctx.fsWatcher, 5000)
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'initial', 5000)
    }, 10000)

    afterEach(async () => {
      plugin.restore()
      writeFileSync(configPath, configBackup)
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    afterAll(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should start and warn once', () => {
      expect(warnings.filter(w => w.includes('source code HMR is disabled'))).to.have.length(1)
    })

    it('should report a source file as pending instead of reloading it', async () => {
      plugin.modify(c => c.replace("value = 'initial'", "value = 'no-internal'"))
      const result = await ctx.hmr.reconcile({ files: [plugin.path] })
      expect(result.pending).to.deep.equal([{ url: pathToFileURL(plugin.path).href, reason: 'cache-unavailable' }])
      expect(result.replaced).to.deep.equal([])

      // nor does a file system change reload it
      await new Promise(r => setTimeout(r, SETTLE_MS))
      expect(ctx.bail('hmr-test/get-value')).to.equal('initial')
    }, 10000)

    it('should still reload config files', async () => {
      writeFileSync(configPath, configBackup.replace(
        '- id: test\n  name: ./plugin',
        '- id: test\n  name: ./plugin\n  disabled: true',
      ))
      await waitFor(() => ctx.bail('hmr-test/get-value') === undefined)

      writeFileSync(configPath, configBackup)
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'initial')
    }, 10000)
  })

  describe('entry changed during unload', () => {
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

    it('does not rebuild an entry disabled during unload', async () => {
      const entry = findEntry(ctx, 'live')
      const previous = entry.fiber!
      const inside = arm(gate)
      // hmr/reload is emitted whether or not stage 3 installs a fiber
      const reloaded = waitForEvent(ctx, 'hmr/reload')
      plugin.modify(content => content.replace("value = 'initial'", "value = 'should-not-live'"))
      await inside

      await entry.update({ disabled: true })
      gate.release?.()
      await reloaded

      expect(entry.disabled).to.equal(true)
      expect(entry.fiber).to.equal(previous)
      expect(previous.uid).to.equal(null)
      expect(ctx.bail('hmr-test/get-value')).to.equal(undefined)
      expect(gate.applies).to.equal(0)
      expect(liveUids(gate)).to.deep.equal([])
    }, 15000)

    it('does not rebuild an entry removed during unload', async () => {
      const entry = findEntry(ctx, 'live')
      const previous = entry.fiber!
      const inside = arm(gate)
      const reloaded = waitForEvent(ctx, 'hmr/reload')
      plugin.modify(content => content.replace("value = 'initial'", "value = 'removed-value'"))
      await inside

      entry.parent.remove(entry.options.id)
      // removal does not set `disabled`
      expect(entry.disabled).to.equal(false)
      gate.release?.()
      await reloaded

      expect(entry.fiber).to.equal(previous)
      expect(previous.uid).to.equal(null)
      expect(ctx.bail('hmr-test/get-value')).to.equal(undefined)
      expect(gate.applies).to.equal(0)
      expect(liveUids(gate)).to.deep.equal([])
    }, 15000)

    it('waits for a second re-enable init before deciding whether to rebuild', async () => {
      const entry = findEntry(ctx, 'live')
      const previous = entry.fiber!
      const inside = arm(gate)
      const reloaded = waitForEvent(ctx, 'hmr/reload')
      plugin.modify(content => content.replace("value = 'initial'", "value = 'second-init'"))
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
          firstInstalled = entry.fiber
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
        expect(liveUids(gate)).to.deep.equal([entry.fiber!.uid])
      } finally {
        releaseFirst()
        releaseSecond()
        disarm(gate)
        stop()
        await Promise.allSettled([updating, reenabled, reloaded])
        // Remove any duplicate produced by a failing implementation before cleanup reloads.
        const current = entry.fiber && Object.getPrototypeOf(entry.fiber)
        await Promise.all(gate.fibers.filter(fiber => fiber !== current).map(fiber => fiber.dispose()))
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
      gate.release?.()
      await reloaded
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'from-host')

      // both the entry root and the child of the host are rebuilt
      expect(gate.applies - appliesBefore).to.equal(2)
      expect(entry.fiber).to.not.equal(previous)
      expect(liveUids(gate)).to.have.length(2)
      // rebuilding the child does not take over the host's entry root
      expect(host.fiber).to.equal(hostRoot)

      await host.update({ disabled: true })
      await hostRoot.await()
      expect(hostRoot.uid).to.equal(null)
      expect(liveUids(gate)).to.deep.equal([entry.fiber!.uid])
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
        const hostRoot = host.fiber!
        await waitFor(() => liveUids(gate).length === 2)

        const inside = arm(gate)
        const reloaded = waitForEvent(ctx, 'hmr/reload')
        plugin.modify(content => content.replace("value = 'initial'", "value = 'host-replaced'"))
        await inside
        await waitFor(() => gate.acquired === 0)

        await host.update({ disabled: true })
        await host.update({ disabled: false })
        expect(hostRoot.uid).to.equal(null)
        expect(host.fiber?.uid ?? null).to.not.equal(null)

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
