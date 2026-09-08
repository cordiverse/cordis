import { Context } from '../src'
import { expect, describe, it } from 'vitest'

describe('internal/update hooks', () => {
  it('does not accumulate non-global hooks across reloads', async () => {
    const root = new Context()
    const calls: number[] = []
    const fiber = root.plugin((ctx) => {
      ctx.on('internal/update', (config, _noSave, next) => {
        calls.push(config.n)
        return next()
      })
    }, { n: 0 })

    await fiber
    fiber.update({ n: 1 })
    await fiber
    fiber.update({ n: 2 })
    await fiber
    fiber.update({ n: 3 })
    await fiber

    expect(calls).to.deep.equal([1, 2, 3])
  })

  it('explicit dispose stops the hook for the current generation', async () => {
    const root = new Context()
    const calls: number[] = []
    let dispose!: () => void
    const fiber = root.plugin((ctx) => {
      dispose = ctx.on('internal/update', (config, _noSave, next) => {
        calls.push(config.n)
        return next()
      })
    }, { n: 0 })

    await fiber
    dispose()
    fiber.update({ n: 1 })
    await fiber
    expect(calls).to.deep.equal([])
  })

  it('global internal/update hooks are not tied to a child fiber reload', async () => {
    const root = new Context()
    const globalCalls: number[] = []
    const localCalls: number[] = []

    root.on('internal/update', (config, _noSave, next) => {
      globalCalls.push(config.n)
      return next()
    }, { global: true })

    const fiber = root.plugin((ctx) => {
      ctx.on('internal/update', (config, _noSave, next) => {
        localCalls.push(config.n)
        return next()
      })
    }, { n: 0 })

    await fiber
    fiber.update({ n: 1 })
    await fiber
    fiber.update({ n: 2 })
    await fiber

    expect(globalCalls).to.deep.equal([1, 2])
    expect(localCalls).to.deep.equal([1, 2])
  })
})
