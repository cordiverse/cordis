import { expect, describe, it, beforeAll } from 'vitest'
import { Context } from 'cordis'
import MockLoader, { sleep } from './utils'

describe('Loader: persist only an accepted update', () => {
  const root = new Context()

  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    // A downstream listener on the same waterfall may veto the update. `update()`
    // documents that: "a listener may veto the restart".
    loader.mock('foo', (ctx: Context) => {
      ctx.on('internal/update', () => {
        throw new Error('vetoed')
      })
    })
  })

  it('leaves the persisted config alone when a listener vetoes the update', async () => {
    const id = await loader.create({ name: 'foo', config: { a: 1 } })
    await sleep()
    const entry = loader.store[id]

    let error: any
    try {
      await entry.fiber!.update({ a: 3 })
    } catch (e) {
      error = e
    }
    expect(error?.message).to.equal('vetoed')

    // The restart never happened, so nothing may claim the new value.
    expect(entry.options.config).to.deep.equal({ a: 1 })
    expect(loader.data[0].config).to.deep.equal({ a: 1 })
  })
})
