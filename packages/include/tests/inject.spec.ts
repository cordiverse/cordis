import { Context, Fiber, FiberState } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import LoggerConsole from '@cordisjs/plugin-logger-console'
import { expect, describe, it, afterEach } from 'vitest'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const url = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

// entry-level `inject` reaching the loader from a config file on disk. The yaml
// `!!js` tag is what makes an expression, so the parse, the structured clone the
// patches apply and the write-back all have to keep it for the scopes to mean
// anything.
describe('Include: entry inject', () => {
  // the committed document is copied out, never loaded in place: a runtime edit
  // writes the tree back, and the fixture has to survive the suite
  const tmp = url('tmp-inject.yml')
  let ctx: Context
  let fiber: Fiber<Context>
  let rootId: string

  afterEach(async () => {
    await fiber?.dispose()
    await rm(tmp, { force: true })
  })

  async function setup(source?: string) {
    if (source === undefined) {
      await copyFile(url('inject.yml'), tmp)
    } else {
      await writeFile(tmp, source)
    }
    ctx = new Context()
    // the parent scope an `inject` value reads: only what the app declares
    // itself is visible there, not a service a sibling entry provides
    ctx.provide('env', { tag: 'p' })
    await ctx.plugin(LoggerConsole)
    fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    rootId = await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: { path: './fixtures/tmp-inject.yml' },
    })
    await ctx.loader.await()
    await sleep(200)
  }

  function entry(id: string) {
    for (const item of ctx.loader.entries()) {
      if (item.options.id === id) return item
    }
    throw new Error(`entry ${id} not found`)
  }

  it('[row1.yaml] resolves an object-form value in the parent scope', async () => {
    await setup()

    const consumer = entry('consumer')
    // the source options keep the expression the yaml tag produced
    expect(consumer.options.inject).to.deep.equal({ service: { tag: { __jsExpr: 'env.tag' } } })
    expect(consumer.inject).to.deep.equal({ service: { tag: 'p' } })
    // and the resolved value reaches the plugin fiber
    expect(consumer.fiber!.inject).to.deep.equal({ service: { tag: 'p' } })
  }, 10000)

  it('[row2.yaml] evaluates disabled against the service the entry injects', async () => {
    await setup()

    const consumer = entry('consumer')
    expect(consumer.disabled).to.equal(false)
    expect(consumer.fiber!.state).to.equal(FiberState.ACTIVE)
    expect(ctx.bail('test/inject').service).to.deep.equal({ tag: 'p' })

    // the control: the verdict has to track the service, otherwise reading it
    // would have been an accident of the value being undefined
    await ctx.loader.update(`${rootId}:provider`, { config: { tag: 'off' } })
    await ctx.loader.await()
    await sleep(200)
    expect(consumer.disabled).to.equal(true)
    expect(consumer.fiber?.state).to.not.equal(FiberState.ACTIVE)
  }, 10000)

  it('keeps the expression when a runtime edit reaches the file', async () => {
    await setup()

    await ctx.loader.update(`${rootId}:consumer`, { config: { label: 'from-runtime' } })
    await ctx.loader.await()
    await sleep(500)

    const text = await readFile(tmp, 'utf-8')
    // the expression, not the value it evaluated to
    expect(text).to.contain('!!js env.tag')
    expect(text).to.contain("!!js service.tag === 'off'")
    expect(ctx.bail('test/inject').config).to.deep.equal({ label: 'from-runtime' })
  }, 10000)

  // the fourth field of the scope table: `intercept` is resolved in the entry
  // injection scope like `disabled`, and the yaml tag has to survive the parse
  // and the write-back for it to mean anything
  it('[row3.yaml] resolves an intercept expression in the entry injection scope', async () => {
    await setup([
      '- id: provider',
      '  name: ./service-plugin',
      '  config:',
      '    tag: from-provider',
      '- id: consumer',
      '  name: ./consumer-plugin',
      '  inject:',
      '    service: true',
      '  intercept:',
      '    service:',
      '      tag: !!js env.tag',
      '',
    ].join('\n'))

    const consumer = entry('consumer')
    // the source options keep the expression the yaml tag produced
    expect(consumer.options.intercept).to.deep.equal({ service: { tag: { __jsExpr: 'env.tag' } } })
    // resolved against `env`, which only the parent scope provides
    expect(consumer.intercept).to.deep.equal({ service: { tag: 'p' } })
    expect(consumer.gate).to.be.ok

    // and the write-back keeps the expression rather than the value
    await ctx.loader.update(`${rootId}:consumer`, { config: { label: 'x' } })
    await ctx.loader.await()
    await sleep(500)
    expect(await readFile(tmp, 'utf-8')).to.contain('!!js env.tag')
  }, 10000)

  // a gated entry reached through a group: the group is structural and keeps
  // its children, and the child still gets a coordinator of its own
  it('holds a gated entry inside a group', async () => {
    await setup([
      '- id: g',
      '  name: \'@cordisjs/plugin-group\'',
      '  group: true',
      '  config:',
      '    - id: provider',
      '      name: ./service-plugin',
      '      config:',
      '        tag: p',
      '    - id: consumer',
      '      name: ./consumer-plugin',
      '      inject:',
      '        service: true',
      '      disabled: !!js service.tag === \'off\'',
      '',
    ].join('\n'))

    const group = entry('g')
    const consumer = entry('consumer')
    // the group entry is structural and survives
    expect(group.options.group).to.be.true
    // the child under it is gated on its own
    expect(consumer.gate).to.be.ok
    expect(consumer.disabled).to.equal(false)
    expect(consumer.fiber!.state).to.equal(FiberState.ACTIVE)

    // the control, driven the way a real edit reaches it: the file changes and
    // the include reconciles. The verdict has to track the service the sibling
    // provides, and the group itself is not what the verdict is about.
    await writeFile(tmp, [
      '- id: g',
      '  name: \'@cordisjs/plugin-group\'',
      '  group: true',
      '  config:',
      '    - id: provider',
      '      name: ./service-plugin',
      '      config:',
      '        tag: off',
      '    - id: consumer',
      '      name: ./consumer-plugin',
      '      inject:',
      '        service: true',
      '      disabled: !!js service.tag === \'off\'',
      '',
    ].join('\n'))
    const include = ctx.loader.store[rootId]!.subtree as any
    await include.refresh()
    await ctx.loader.await()
    await sleep(200)
    expect(consumer.disabled).to.equal(true)
    expect(consumer.fiber?.state).to.not.equal(FiberState.ACTIVE)
    expect(entry('g').fiber!.state).to.equal(FiberState.ACTIVE)
  }, 10000)

  // row 4 at the yaml layer: the tag has to survive the parse for a `config`
  // expression to mean anything, and the expression reads `service`, which only
  // the plugin's own `inject` makes visible
  it('[row4.yaml] interpolates a config expression through the yaml tag', async () => {
    await setup([
      '- id: provider',
      '  name: ./service-plugin',
      '  config:',
      '    tag: x',
      '- id: consumer',
      '  name: ./consumer-plugin',
      '  inject:',
      '    service: true',
      '  config:',
      '    label: !!js service.tag',
      '',
    ].join('\n'))

    expect(ctx.bail('test/inject').config).to.deep.equal({ label: 'x' })
    // the source options keep the expression rather than the value
    expect(entry('consumer').options.config).to.deep.equal({ label: { __jsExpr: 'service.tag' } })
  }, 10000)
})
