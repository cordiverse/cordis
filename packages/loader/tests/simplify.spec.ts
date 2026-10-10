import { expect, describe, it, beforeAll } from 'vitest'
import { Context } from 'cordis'
import Schema from 'schemastery'
import MockLoader from './utils'

// The `default` is what makes the second case collapse to `null`.
const foo = Object.assign((ctx: Context) => {
  ctx.on('internal/update', (_config: any, next: any) => next())
}, { Config: Schema.object({ a: Schema.number().default(1) }) })

describe('Loader: persist a simplified config', () => {
  const root = new Context()
  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('foo', foo)
  })

  it('applies the schema when persisting a self-update', async () => {
    await loader.read([{ id: '1', name: 'foo', config: { a: 1 } }])

    await loader.expectFiber('1').update({ a: 3 })

    expect(loader.data).to.deep.equal([{
      id: '1',
      name: 'foo',
      config: { a: 3 },
    }])
  })

  it('collapses a config that holds nothing but defaults', async () => {
    await loader.expectFiber('1').update({ a: 1 })

    expect(loader.data).to.deep.equal([{
      id: '1',
      name: 'foo',
      config: null,
    }])
  })
})
