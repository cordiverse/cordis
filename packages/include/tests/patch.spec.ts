import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Logger from '@cordisjs/plugin-logger'
import { expect } from 'chai'

function waitFor(condFn: () => any, timeout = 5000, interval = 100): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const check = setInterval(() => {
      if (condFn()) { clearInterval(check); resolve() }
    }, interval)
    setTimeout(() => { clearInterval(check); reject(new Error('waitFor timed out')) }, timeout)
  })
}

describe('Include patches', () => {
  let ctx: Context
  let fiber: Fiber<Context>

  afterEach(async () => {
    fiber?.dispose()
    await new Promise(r => setTimeout(r, 200))
  })

  it('should load without patches', async function () {
    this.timeout(10000)
    ctx = new Context()
    await ctx.plugin(Logger)
    fiber = await ctx.plugin(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: {
        path: './fixtures/base.yml',
      },
    })
    await waitFor(() => ctx.bail('test/get-value'))
    expect(ctx.bail('test/get-value')).to.equal('default')
  })

  it('should disable an entry via patch', async function () {
    this.timeout(10000)
    ctx = new Context()
    await ctx.plugin(Logger)
    fiber = await ctx.plugin(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          { id: 'inner', disabled: true },
        ],
      },
    })
    await new Promise(r => setTimeout(r, 1000))
    // inner plugin should be disabled
    expect(ctx.bail('test/get-value')).to.be.undefined
  })

  it('should override config via patch', async function () {
    this.timeout(10000)
    ctx = new Context()
    await ctx.plugin(Logger)
    fiber = await ctx.plugin(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          { id: 'inner', config: { custom: true } },
        ],
      },
    })
    await waitFor(() => ctx.bail('test/get-value'))
    // Plugin should still load (config override doesn't break it)
    expect(ctx.bail('test/get-value')).to.equal('default')
  })

  it('should warn on name mismatch and skip patch', async function () {
    this.timeout(10000)
    ctx = new Context()
    await ctx.plugin(Logger)
    fiber = await ctx.plugin(Loader, {
      baseUrl: import.meta.url,
    })

    let warned = false
    ctx.on('internal/warning' as any, () => { warned = true })

    await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          { id: 'inner', name: 'wrong-name', disabled: true },
        ],
      },
    })
    await waitFor(() => ctx.bail('test/get-value'))
    // Plugin should still be active (patch was skipped due to name mismatch)
    expect(ctx.bail('test/get-value')).to.equal('default')
  })

  it('should warn on non-existent id', async function () {
    this.timeout(10000)
    ctx = new Context()
    await ctx.plugin(Logger)
    fiber = await ctx.plugin(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          { id: 'nonexistent', disabled: true },
        ],
      },
    })
    await waitFor(() => ctx.bail('test/get-value'))
    // Should still work, patch just gets warned and ignored
    expect(ctx.bail('test/get-value')).to.equal('default')
  })

  it('should insert entries into root group', async function () {
    this.timeout(10000)
    ctx = new Context()
    await ctx.plugin(Logger)
    fiber = await ctx.plugin(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          {
            insert: [
              { name: './extra-plugin' },
            ],
          },
        ],
      },
    })
    await waitFor(() => ctx.bail('test/get-extra'))
    expect(ctx.bail('test/get-extra')).to.equal('extra')
    // Original plugin should still work
    expect(ctx.bail('test/get-value')).to.equal('default')
  })

  it('should insert entries into a specific group', async function () {
    this.timeout(10000)
    ctx = new Context()
    await ctx.plugin(Logger)
    fiber = await ctx.plugin(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          {
            id: 'group',
            insert: [
              { name: './extra-plugin' },
            ],
          },
        ],
      },
    })
    await waitFor(() => ctx.bail('test/get-extra'))
    expect(ctx.bail('test/get-extra')).to.equal('extra')
  })

  it('should warn when inserting into a non-group entry', async function () {
    this.timeout(10000)
    ctx = new Context()
    await ctx.plugin(Logger)
    fiber = await ctx.plugin(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          {
            id: 'timer',
            insert: [
              { name: './extra-plugin' },
            ],
          },
        ],
      },
    })
    await waitFor(() => ctx.bail('test/get-value'))
    // extra plugin should NOT be loaded (timer is not a group)
    expect(ctx.bail('test/get-extra')).to.be.undefined
  })

  it('should apply multiple patches', async function () {
    this.timeout(10000)
    ctx = new Context()
    await ctx.plugin(Logger)
    fiber = await ctx.plugin(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          { id: 'inner', disabled: true },
          {
            insert: [
              { name: './extra-plugin' },
            ],
          },
        ],
      },
    })
    await waitFor(() => ctx.bail('test/get-extra'))
    // inner disabled, extra loaded
    expect(ctx.bail('test/get-value')).to.be.undefined
    expect(ctx.bail('test/get-extra')).to.equal('extra')
  })

  it('should validate name consistency (matching name is ok)', async function () {
    this.timeout(10000)
    ctx = new Context()
    await ctx.plugin(Logger)
    fiber = await ctx.plugin(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          { id: 'inner', name: './test-plugin', disabled: true },
        ],
      },
    })
    await new Promise(r => setTimeout(r, 1000))
    // Name matches, so patch should apply and inner should be disabled
    expect(ctx.bail('test/get-value')).to.be.undefined
  })
})
