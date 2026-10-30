import { expect, describe, it, beforeAll } from 'vitest'
import { Context } from 'cordis'
import MockLoader, { sleep } from './utils'

describe('Loader: persist only an accepted update', () => {
  const root = new Context()
  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    // A downstream listener on the `internal/update` waterfall may veto the
    // update; the config must stay untouched in every persistence surface.
    loader.mock('foo', (ctx: Context) => {
      ctx.on('internal/update', () => {
        throw new Error('vetoed')
      })
    })
    loader.mock('bar', () => {})
  })

  it('leaves both the entry and the tree data alone when a listener vetoes', async () => {
    const id = await loader.create({ name: 'foo', config: { a: 1 } })
    await sleep()

    let error: any
    try {
      await loader.expectFiber(id).update({ a: 3 })
    } catch (e) {
      error = e
    }
    expect(error?.message).to.equal('vetoed')

    expect(loader.store[id].options.config).to.deep.equal({ a: 1 })
    expect(loader.data[0].config).to.deep.equal({ a: 1 })
  })

  it('writes an accepted update', async () => {
    const id = await loader.create({ name: 'bar', config: { a: 1 } })
    await sleep()

    await loader.expectFiber(id).update({ a: 2 })
    await sleep()

    expect(loader.store[id].options.config).to.deep.equal({ a: 2 })
    expect(loader.data.at(-1)!.config).to.deep.equal({ a: 2 })
  })
})
