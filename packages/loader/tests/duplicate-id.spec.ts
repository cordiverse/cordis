import { Context } from 'cordis'
import { expect, describe, it } from 'vitest'
import MockLoader, { sleep } from './utils'

describe('Loader: duplicate entry id', () => {
  it('reports a repeated id instead of dropping one silently', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as any
    loader.mock('foo', () => {})

    await loader.read([
      { id: 'dup', name: 'foo', config: { tag: 1 } },
      { id: 'dup', name: 'foo', config: { tag: 2 } },
    ])
    await sleep()

    const errors = root.logger.buffer.filter((message: any) => message.type === 'error')
    expect(errors).to.have.length(1)
    expect(errors[0].args[0]).to.include('duplicate entry id')
    expect(errors[0].args[1]).to.equal('dup')
    // the last entry still takes effect
    expect(loader.store['dup'].options.config).to.deep.equal({ tag: 2 })
  })

  it('reports creating over an existing id', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as any
    loader.mock('foo', () => {})

    await loader.read([{ id: 'single', name: 'foo', config: { tag: 1 } }])
    await sleep()

    await loader.create({ id: 'single', name: 'foo', config: { tag: 2 } })
    await sleep()

    const errors = root.logger.buffer.filter((message: any) => message.type === 'error')
    expect(errors).to.have.length(1)
    expect(errors[0].args[0]).to.include('duplicate entry id')
    expect(errors[0].args[1]).to.equal('single')
    expect(loader.store['single'].options.config).to.deep.equal({ tag: 2 })
  })

  it('does not report an id kept across reloads', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as any
    loader.mock('foo', () => {})

    await loader.read([{ id: 'keep', name: 'foo', config: { tag: 1 } }])
    await sleep()
    await loader.read([{ id: 'keep', name: 'foo', config: { tag: 2 } }])
    await sleep()

    const errors = root.logger.buffer.filter((message: any) => message.type === 'error')
    expect(errors).to.have.length(0)
    expect(loader.store['keep'].options.config).to.deep.equal({ tag: 2 })
  })

  it('does not report an entry moved into another group', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as any
    loader.mock('foo', () => {})

    await loader.read([{ id: 'moved', name: 'foo', config: { tag: 1 } }])
    await sleep()
    const group = await loader.create({
      name: '@cordisjs/plugin-group',
      group: true,
      config: [],
    })
    await sleep()

    await loader.create({ id: 'moved', name: 'foo', config: { tag: 2 } }, group)
    await sleep()

    const errors = root.logger.buffer.filter((message: any) => message.type === 'error')
    expect(errors).to.have.length(0)
    expect(loader.store['moved'].parent).to.equal(loader.store[group].subgroup)
    expect(loader.store['moved'].options.config).to.deep.equal({ tag: 2 })
  })
})
