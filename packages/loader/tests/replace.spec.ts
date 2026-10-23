import { expect, describe, it, beforeAll } from 'vitest'
import { Context } from 'cordis'
import MockLoader from './utils.ts'

// The swap itself is `registry.replace()`; core tests cover it. What this pins
// is the loader's half: the entry's own `inject` lives on the outer fiber, and a
// replacement would leave that fiber holding only the inject of the new plugin.
describe('Loader: internal/replace', () => {
  const root = new Context()
  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('settings', (ctx: Context, config: any) => {
      ctx.provide('settings', { ...config })
    })
    loader.mock('worker', () => {})
  })

  it('merges the entry inject back into the outer fiber', async () => {
    await loader.read([
      { id: 'settings', name: 'settings', config: {} },
      { id: 'worker', name: 'worker', inject: ['settings'] },
    ])

    const entry = loader.store.worker
    const outer = entry.outerFiber
    expect(Object.keys(outer.inject)).to.deep.equal(['settings'])

    // what `replace()` installs: the inject of the plugin, which here is none
    outer.inject = Object.create(null)
    outer.context.emit('internal/replace', outer)

    expect(Object.keys(outer.inject)).to.deep.equal(['settings'])
    // the plugin fiber never carried the entry's inject, so it stays untouched
    expect(Object.keys(entry.innerFiber.inject)).to.deep.equal([])
  })
})
