import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Logger from '@cordisjs/plugin-logger'
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect } from 'chai'
import { pathToFileURL } from 'node:url'

const testDir = new URL('.', import.meta.url).pathname

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
      url: pathToFileURL(resolve(testDir, configFile)).href,
    },
  })
  await waitFor(() => ctx.hmr, 5000)
  await new Promise(r => setTimeout(r, 500))
  return { ctx, fiber }
}

// Settle time after file restore, to let any triggered HMR finish
const SETTLE_MS = 500

describe('HMR', () => {
  // ===== Basic single plugin tests =====
  describe('basic single plugin', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const plugin = backupFile('plugin.ts')

    before(async function () {
      this.timeout(10000)
      plugin.restore()
      const result = await createContext('cordis.yml')
      ctx = result.ctx
      fiber = result.fiber
    })

    afterEach(async () => {
      plugin.restore()
      // Wait for any HMR triggered by restore to settle
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    after(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should load plugin and respond to events', () => {
      const value = ctx.bail('hmr-test/get-value')
      expect(value).to.equal('initial')
    })

    it('should reload plugin when file changes', async function () {
      this.timeout(10000)

      let disposed = false
      ctx.on('hmr-test/disposed', () => { disposed = true })

      plugin.modify(c => c.replace("value = 'initial'", "value = 'modified'"))

      await waitFor(() => ctx.bail('hmr-test/get-value') === 'modified')

      expect(ctx.bail('hmr-test/get-value')).to.equal('modified')
      expect(disposed).to.be.true
    })

    it('should handle reverting file back to original', async function () {
      this.timeout(10000)

      // First change it
      plugin.modify(c => c.replace("value = 'initial'", "value = 'to-revert'"))
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'to-revert')

      // Then revert
      plugin.restore()
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'initial')

      expect(ctx.bail('hmr-test/get-value')).to.equal('initial')
    })

    it('should emit hmr/reload event on reload', async function () {
      this.timeout(10000)

      const reloadPromise = waitForEvent(ctx, 'hmr/reload')
      plugin.modify(c => c.replace("value = 'initial'", "value = 'event-test'"))

      const [reloads] = await reloadPromise
      expect(reloads).to.be.instanceOf(Map)
      expect(reloads.size).to.be.greaterThan(0)

      for (const [, reload] of reloads) {
        expect(reload).to.have.property('filename')
      }
    })

    it('should properly dispose old plugin effects on reload', async function () {
      this.timeout(10000)

      let disposeCount = 0
      ctx.on('hmr-test/disposed', () => { disposeCount++ })

      plugin.modify(c => c.replace("value = 'initial'", "value = 'dispose-test-1'"))
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'dispose-test-1')

      const countAfterFirst = disposeCount

      plugin.write(plugin.original.replace("value = 'initial'", "value = 'dispose-test-2'"))
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'dispose-test-2')

      expect(disposeCount).to.be.greaterThan(countAfterFirst)
    })
  })

  // ===== Multiple plugins =====
  describe('multiple plugins', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const pluginA = backupFile('plugin-a.ts')
    const pluginB = backupFile('plugin-b.ts')

    before(async function () {
      this.timeout(10000)
      pluginA.restore()
      pluginB.restore()
      const result = await createContext('cordis-multi.yml')
      ctx = result.ctx
      fiber = result.fiber
    })

    afterEach(async () => {
      pluginA.restore()
      pluginB.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    after(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should load multiple plugins', () => {
      expect(ctx.bail('hmr-test/get-a')).to.equal('alpha')
      expect(ctx.bail('hmr-test/get-b')).to.equal('beta')
    })

    it('should reload changed plugin without affecting others', async function () {
      this.timeout(10000)

      // modify only plugin A
      pluginA.modify(c => c.replace("value = 'alpha'", "value = 'alpha-v2'"))

      await waitFor(() => ctx.bail('hmr-test/get-a') === 'alpha-v2')

      expect(ctx.bail('hmr-test/get-a')).to.equal('alpha-v2')
      // plugin B should remain unchanged
      expect(ctx.bail('hmr-test/get-b')).to.equal('beta')
    })

    it('should handle simultaneous changes to both plugins', async function () {
      this.timeout(10000)

      pluginA.modify(c => c.replace("value = 'alpha'", "value = 'alpha-v3'"))
      pluginB.modify(c => c.replace("value = 'beta'", "value = 'beta-v3'"))

      await waitFor(() =>
        ctx.bail('hmr-test/get-a') === 'alpha-v3' &&
        ctx.bail('hmr-test/get-b') === 'beta-v3',
      )

      expect(ctx.bail('hmr-test/get-a')).to.equal('alpha-v3')
      expect(ctx.bail('hmr-test/get-b')).to.equal('beta-v3')
    })
  })

  // ===== Dependency chain =====
  describe('dependency chain', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const dep = backupFile('dep.ts')
    const pluginDep = backupFile('plugin-dep.ts')

    before(async function () {
      this.timeout(10000)
      dep.restore()
      pluginDep.restore()
      const result = await createContext('cordis-dep.yml')
      ctx = result.ctx
      fiber = result.fiber
    })

    afterEach(async () => {
      dep.restore()
      pluginDep.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    after(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should load plugin with dependency', () => {
      expect(ctx.bail('hmr-test/get-dep')).to.equal('original-shared')
    })

    it('should reload plugin when its dependency changes', async function () {
      this.timeout(10000)

      let disposed = false
      ctx.on('hmr-test/disposed-dep', () => { disposed = true })

      dep.modify(c => c.replace("sharedValue = 'original-shared'", "sharedValue = 'updated-shared'"))

      await waitFor(() => ctx.bail('hmr-test/get-dep') === 'updated-shared')

      expect(ctx.bail('hmr-test/get-dep')).to.equal('updated-shared')
      expect(disposed).to.be.true
    })

    it('should reload plugin when plugin file itself changes', async function () {
      this.timeout(10000)

      pluginDep.modify(c => c.replace(
        "ctx.on('hmr-test/get-dep', () => sharedValue)",
        "ctx.on('hmr-test/get-dep', () => 'prefix:' + sharedValue)",
      ))

      await waitFor(() => {
        const v = ctx.bail('hmr-test/get-dep')
        return typeof v === 'string' && v.startsWith('prefix:')
      })

      expect(ctx.bail('hmr-test/get-dep')).to.equal('prefix:original-shared')
    })
  })

  // ===== Import error rollback =====
  describe('import error rollback', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const pluginError = backupFile('plugin-error.ts')

    before(async function () {
      this.timeout(10000)
      pluginError.restore()
      const result = await createContext('cordis-error.yml')
      ctx = result.ctx
      fiber = result.fiber
    })

    afterEach(async () => {
      pluginError.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    after(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should load plugin normally', () => {
      expect(ctx.bail('hmr-test/get-error')).to.equal('ok')
    })

    it('should rollback on syntax error and keep old plugin working', async function () {
      this.timeout(10000)

      pluginError.write(`
        import { Context } from 'cordis'
        export const name = 'plugin-error'
        export function apply(ctx: Context {{{ BROKEN
      `)

      await new Promise(r => setTimeout(r, 2000))

      // the old plugin should still be functional after rollback
      expect(ctx.bail('hmr-test/get-error')).to.equal('ok')
    })

    it('should recover after fixing the error', async function () {
      this.timeout(10000)

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
    })
  })

  // ===== Debounce =====
  describe('debounce', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const plugin = backupFile('plugin.ts')

    before(async function () {
      this.timeout(10000)
      plugin.restore()
      const result = await createContext('cordis.yml')
      ctx = result.ctx
      fiber = result.fiber
    })

    afterEach(async () => {
      plugin.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    after(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should batch rapid changes within debounce window', async function () {
      this.timeout(10000)

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
    })
  })

  // ===== Config file reload =====
  describe('config file changes', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const configPath = resolve(testDir, 'cordis.yml')
    const configBackup = readFileSync(configPath, 'utf-8')
    const plugin = backupFile('plugin.ts')

    before(async function () {
      this.timeout(10000)
      plugin.restore()
      writeFileSync(configPath, configBackup)
      const result = await createContext('cordis.yml')
      ctx = result.ctx
      fiber = result.fiber
    })

    afterEach(async () => {
      plugin.restore()
      writeFileSync(configPath, configBackup)
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    after(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should handle config file update to disable plugin', async function () {
      this.timeout(10000)

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
    })
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

    before(() => {
      writeFileSync(pluginPath, servicePluginContent)
      writeFileSync(configPath, `- id: timer
  name: '@cordisjs/plugin-timer'
- id: hmr
  name: '@cordisjs/plugin-hmr'
  config:
    root:
      - .
    debounce: 50
- id: my-service
  name: ./plugin-service
`)
    })

    afterEach(async () => {
      writeFileSync(pluginPath, servicePluginContent)
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    after(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
      try { unlinkSync(pluginPath) } catch {}
      try { unlinkSync(configPath) } catch {}
    })

    it('should load service plugin', async function () {
      this.timeout(10000)
      const result = await createContext('cordis-service.yml')
      ctx = result.ctx
      fiber = result.fiber

      await waitFor(() => ctx.myService)
      expect(ctx.myService.getValue()).to.equal('service-v1')
    })

    it('should reload service plugin on change', async function () {
      this.timeout(10000)

      const content = readFileSync(pluginPath, 'utf-8')
      writeFileSync(pluginPath, content.replace("data = 'service-v1'", "data = 'service-v2'"))

      await waitFor(() => ctx.myService?.getValue() === 'service-v2')
      expect(ctx.myService.getValue()).to.equal('service-v2')
    })
  })

  // ===== Fiber/entry re-association =====
  describe('fiber and entry re-association', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const plugin = backupFile('plugin.ts')

    before(async function () {
      this.timeout(10000)
      plugin.restore()
      const result = await createContext('cordis.yml')
      ctx = result.ctx
      fiber = result.fiber
    })

    afterEach(async () => {
      plugin.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    after(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should maintain entry association after reload', async function () {
      this.timeout(10000)

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
    })
  })

  // ===== Rapid successive reloads =====
  describe('rapid successive reloads', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const plugin = backupFile('plugin.ts')

    before(async function () {
      this.timeout(10000)
      plugin.restore()
      const result = await createContext('cordis.yml')
      ctx = result.ctx
      fiber = result.fiber
    })

    after(async () => {
      plugin.restore()
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should handle many rapid reloads without crashing', async function () {
      this.timeout(20000)

      for (let i = 0; i < 5; i++) {
        plugin.write(plugin.original.replace("value = 'initial'", `value = 'v${i}'`))
        await new Promise(r => setTimeout(r, 200))
      }

      await waitFor(() => ctx.bail('hmr-test/get-value') === 'v4')
      expect(ctx.bail('hmr-test/get-value')).to.equal('v4')
    })
  })

  // ===== Event handler addition/removal =====
  describe('event handler changes', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const pluginEv = backupFile('plugin-event.ts')

    before(async function () {
      this.timeout(10000)
      pluginEv.restore()
      const result = await createContext('cordis-event.yml')
      ctx = result.ctx
      fiber = result.fiber
    })

    afterEach(async () => {
      pluginEv.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    after(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should register new event handlers after reload', async function () {
      this.timeout(10000)

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
    ctx.root.emit('hmr-test/disposed-event')
  })
}
`)

      await waitFor(() => ctx.bail('hmr-test/get-event') === 'with-extra')

      expect(ctx.bail('hmr-test/get-event')).to.equal('with-extra')
      expect(ctx.bail('hmr-test/get-extra')).to.equal('extra-data')
    })

    it('should remove old event handlers after reload', async function () {
      this.timeout(10000)

      // First add extra handler
      pluginEv.write(`
import { Context } from 'cordis'

export const name = 'test-plugin-event'
export let value = 'with-extra'

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-event', () => value)
  ctx.on('hmr-test/get-extra', () => 'extra-data')
  ctx.effect(() => () => {
    ctx.root.emit('hmr-test/disposed-event')
  })
}
`)
      await waitFor(() => ctx.bail('hmr-test/get-extra') === 'extra-data')

      // Then restore original (no extra handler)
      pluginEv.restore()

      await waitFor(() => ctx.bail('hmr-test/get-event') === 'initial')

      expect(ctx.bail('hmr-test/get-event')).to.equal('initial')
      expect(ctx.bail('hmr-test/get-extra')).to.be.undefined
    })
  })

  // ===== getLinked =====
  describe('getLinked', () => {
    let ctx: Context
    let fiber: Fiber<Context>

    before(async function () {
      this.timeout(10000)
      const result = await createContext('cordis-dep.yml')
      ctx = result.ctx
      fiber = result.fiber
    })

    after(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should return linked dependencies for a loaded file', async () => {
      const pluginDepPath = resolve(testDir, 'plugin-dep.ts')
      const linked = await ctx.hmr.getLinked(pluginDepPath)

      expect(linked).to.be.an('array')
      const depPath = resolve(testDir, 'dep.ts')
      expect(linked).to.include(depPath)
    })

    it('should return empty array for unknown file', async () => {
      const linked = await ctx.hmr.getLinked('/nonexistent/file.ts')
      expect(linked).to.deep.equal([])
    })
  })

  // ===== relative path helper =====
  describe('relative', () => {
    let ctx: Context
    let fiber: Fiber<Context>

    before(async function () {
      this.timeout(10000)
      const result = await createContext('cordis.yml')
      ctx = result.ctx
      fiber = result.fiber
    })

    after(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should compute relative path from base', () => {
      const abs = resolve(testDir, 'plugin.ts')
      const rel = ctx.hmr.relative(abs)
      expect(rel).to.equal('plugin.ts')
    })
  })

  // ===== Runtime error in apply =====
  describe('runtime error in plugin apply', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const pluginError = backupFile('plugin-error.ts')

    before(async function () {
      this.timeout(10000)
      pluginError.restore()
      const result = await createContext('cordis-error.yml')
      ctx = result.ctx
      fiber = result.fiber
    })

    afterEach(async () => {
      pluginError.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    after(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should handle apply error gracefully without crashing', async function () {
      this.timeout(15000)

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
    })
  })

  // ===== Stash clearing =====
  describe('stash management', () => {
    let ctx: Context
    let fiber: Fiber<Context>
    const plugin = backupFile('plugin.ts')

    before(async function () {
      this.timeout(10000)
      plugin.restore()
      const result = await createContext('cordis.yml')
      ctx = result.ctx
      fiber = result.fiber
    })

    afterEach(async () => {
      plugin.restore()
      await new Promise(r => setTimeout(r, SETTLE_MS))
    })

    after(async () => {
      fiber?.dispose()
      await new Promise(r => setTimeout(r, 200))
    })

    it('should clear stashed files after successful reload', async function () {
      this.timeout(10000)

      plugin.modify(c => c.replace("value = 'initial'", "value = 'stash-test'"))
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'stash-test')

      // After successful reload, changing the same file again should work
      plugin.write(plugin.original.replace("value = 'initial'", "value = 'stash-test-2'"))
      await waitFor(() => ctx.bail('hmr-test/get-value') === 'stash-test-2')

      expect(ctx.bail('hmr-test/get-value')).to.equal('stash-test-2')
    })
  })
})
