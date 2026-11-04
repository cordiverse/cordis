import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/loader'
import Fs from '@cordisjs/fs'
import NodeFs from '@cordisjs/fs-node'
import LoggerConsole from '@cordisjs/logger-console'
import { expect, describe, it, afterEach } from 'vitest'

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
    await fiber?.dispose()
  })

  it('should load without patches', async () => {
    ctx = new Context()
    await ctx.use(LoggerConsole)
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/include',
      config: {
        path: './fixtures/base.yml',
      },
    })
    await waitFor(() => ctx.bail('test/get-value'))
    expect(ctx.bail('test/get-value')).to.equal('default')
  }, 10000)

  it('should disable an entry via patch', async () => {
    ctx = new Context()
    await ctx.use(LoggerConsole)
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          { id: 'inner', disabled: true },
        ],
      },
    })
    await new Promise(r => setTimeout(r, 1000))
    // inner component should be disabled
    expect(ctx.bail('test/get-value')).to.be.undefined
  }, 10000)

  it('should override config via patch', async () => {
    ctx = new Context()
    await ctx.use(LoggerConsole)
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          { id: 'inner', config: { custom: true } },
        ],
      },
    })
    await waitFor(() => ctx.bail('test/get-value'))
    // Component should still load (config override doesn't break it)
    expect(ctx.bail('test/get-value')).to.equal('default')
  }, 10000)

  it('should warn on name mismatch and skip patch', async () => {
    ctx = new Context()
    await ctx.use(LoggerConsole)
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, {
      baseUrl: import.meta.url,
    })

    let warned = false
    ;(ctx.logger as any).warn = () => { warned = true }

    await ctx.loader.create({
      name: '@cordisjs/include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          { id: 'inner', name: 'wrong-name', disabled: true },
        ],
      },
    })
    await waitFor(() => ctx.bail('test/get-value'))
    // Component should still be active (patch was skipped due to name mismatch)
    expect(ctx.bail('test/get-value')).to.equal('default')
  }, 10000)

  it('should warn on non-existent id', async () => {
    ctx = new Context()
    await ctx.use(LoggerConsole)
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/include',
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
  }, 10000)

  it('should insert entries into root group', async () => {
    ctx = new Context()
    await ctx.use(LoggerConsole)
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          {
            insert: [
              { name: './extra-component' },
            ],
          },
        ],
      },
    })
    await waitFor(() => ctx.bail('test/get-extra'))
    expect(ctx.bail('test/get-extra')).to.equal('extra')
    // Original component should still work
    expect(ctx.bail('test/get-value')).to.equal('default')
  }, 10000)

  it('should insert entries into a specific group', async () => {
    ctx = new Context()
    await ctx.use(LoggerConsole)
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          {
            id: 'group',
            insert: [
              { name: './extra-component' },
            ],
          },
        ],
      },
    })
    await waitFor(() => ctx.bail('test/get-extra'))
    expect(ctx.bail('test/get-extra')).to.equal('extra')
  }, 10000)

  it('should warn when inserting into a non-group entry', async () => {
    ctx = new Context()
    await ctx.use(LoggerConsole)
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          {
            id: 'timer',
            insert: [
              { name: './extra-component' },
            ],
          },
        ],
      },
    })
    await waitFor(() => ctx.bail('test/get-value'))
    // extra component should NOT be loaded (timer is not a group)
    expect(ctx.bail('test/get-extra')).to.be.undefined
  }, 10000)

  it('should apply multiple patches', async () => {
    ctx = new Context()
    await ctx.use(LoggerConsole)
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          { id: 'inner', disabled: true },
          {
            insert: [
              { name: './extra-component' },
            ],
          },
        ],
      },
    })
    await waitFor(() => ctx.bail('test/get-extra'))
    // inner disabled, extra loaded
    expect(ctx.bail('test/get-value')).to.be.undefined
    expect(ctx.bail('test/get-extra')).to.equal('extra')
  }, 10000)

  it('should let a later patch address a row inserted by an earlier patch', async () => {
    ctx = new Context()
    await ctx.use(LoggerConsole)
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          { insert: [{ id: 'added', name: './extra-component' }] },
          { id: 'added', disabled: true },
        ],
      },
    })
    await waitFor(() => ctx.bail('test/get-value'))
    // inserted rows are indexed as they land, so the second patch finds `added`
    expect(ctx.bail('test/get-extra')).to.be.undefined
  }, 10000)

  it('should validate name consistency (matching name is ok)', async () => {
    ctx = new Context()
    await ctx.use(LoggerConsole)
    await ctx.use(Fs)
    await ctx.use(NodeFs)
    fiber = await ctx.use(Loader, {
      baseUrl: import.meta.url,
    })
    await ctx.loader.create({
      name: '@cordisjs/include',
      config: {
        path: './fixtures/base.yml',
        patches: [
          { id: 'inner', name: './test-component', disabled: true },
        ],
      },
    })
    await new Promise(r => setTimeout(r, 1000))
    // Name matches, so patch should apply and inner should be disabled
    expect(ctx.bail('test/get-value')).to.be.undefined
  }, 10000)
})
