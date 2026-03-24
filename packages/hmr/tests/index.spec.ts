import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Logger from '@cordisjs/plugin-logger'
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect } from 'chai'

const testDir = new URL('.', import.meta.url).pathname
const pluginPath = resolve(testDir, 'plugin.ts')
const pluginBackup = readFileSync(pluginPath, 'utf-8')

describe('HMR', () => {
  let ctx: Context
  let fiber: Fiber<Context>

  afterEach(() => {
    // restore original plugin file
    writeFileSync(pluginPath, pluginBackup)
  })

  after(() => {
    fiber?.dispose()
  })

  it('should load plugin and respond to events', async () => {
    ctx = new Context()
    await ctx.plugin(Logger)
    fiber = await ctx.plugin(Loader, {
      name: 'cordis',
      filename: resolve(testDir, 'cordis.yml'),
    })
    // wait for all plugins to settle
    await new Promise(r => setTimeout(r, 2000))

    // check that test plugin is loaded
    const value = ctx.bail('hmr-test/get-value')
    expect(value).to.equal('initial')
  })

  it('should reload plugin when file changes', async function () {
    this.timeout(10000)

    // track disposals
    let disposed = false
    ctx.on('hmr-test/disposed', () => { disposed = true })

    // modify the plugin file
    const modified = pluginBackup.replace("value = 'initial'", "value = 'modified'")
    writeFileSync(pluginPath, modified)

    // wait for HMR to detect and reload
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const newValue = ctx.bail('hmr-test/get-value')
        if (newValue === 'modified') {
          clearInterval(check)
          resolve()
        }
      }, 200)
      // timeout after 8s
      setTimeout(() => { clearInterval(check); resolve() }, 8000)
    })

    // verify new behavior
    const value = ctx.bail('hmr-test/get-value')
    expect(value).to.equal('modified')

    // verify old plugin was disposed
    expect(disposed).to.be.true
  })

  it('should handle reverting file back', async function () {
    this.timeout(10000)

    // revert to original
    writeFileSync(pluginPath, pluginBackup)

    // wait for HMR reload
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const val = ctx.bail('hmr-test/get-value')
        if (val === 'initial') {
          clearInterval(check)
          resolve()
        }
      }, 200)
      setTimeout(() => { clearInterval(check); resolve() }, 8000)
    })

    const value = ctx.bail('hmr-test/get-value')
    expect(value).to.equal('initial')
  })
})
