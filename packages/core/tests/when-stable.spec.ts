import { Context } from '../src/index.ts'
import { describe, expect, it } from 'vitest'

describe('Fiber: whenStable', () => {
  it('emits once for the latest config of a burst', async () => {
    const root = new Context()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const writes: number[] = []
    const commits: number[] = []
    const fiber = await root.plugin((ctx: Context, config: { value: number }) => {
      writes.push(config.value)
      ctx.on('internal/update', async (config: { value: number }) => {
        if (config.value === 1) {
          started.resolve()
          await release.promise
        }
        writes.push(config.value)
        ctx.fiber.whenStable(config, () => commits.push(config.value))
        // veto the restart: the write above is the whole effect
      })
    }, { value: 0 })

    const first = Promise.resolve(fiber.update({ value: 1 }))
    await started.promise
    const second = Promise.resolve(fiber.update({ value: 2 }))
    release.resolve()
    await Promise.all([first, second, fiber.await()])

    expect(writes).to.deep.equal([0, 2, 1])
    expect(commits).to.deep.equal([2])
    await root.fiber.dispose()
  })

  it('never fires a superseded generation', async () => {
    const root = new Context()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const commits: number[] = []
    const fiber = await root.plugin((ctx: Context, config: { value: number }) => {
      ctx.on('internal/update', async (config: { value: number }) => {
        if (config.value === 1) {
          started.resolve()
          await release.promise
          ctx.fiber.whenStable(config, () => commits.push(config.value))
        }
        // the newer generation registers nothing
      })
    }, { value: 0 })

    const first = Promise.resolve(fiber.update({ value: 1 }))
    await started.promise
    const second = Promise.resolve(fiber.update({ value: 2 }))
    release.resolve()
    await Promise.all([first, second, fiber.await()])

    expect(commits).to.deep.equal([])
    await root.fiber.dispose()
  })

  it('drops a pending commit when the fiber is disposed', async () => {
    const root = new Context()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const commits: number[] = []
    const fiber = await root.plugin((ctx: Context, config: { value: number }) => {
      ctx.on('internal/update', async (config: { value: number }) => {
        if (config.value === 1) {
          started.resolve()
          await release.promise
          ctx.fiber.whenStable(config, () => commits.push(config.value))
        }
      })
    }, { value: 0 })

    const first = Promise.resolve(fiber.update({ value: 1 }))
    await started.promise
    const disposing = fiber.dispose()
    release.resolve()
    await Promise.all([first, disposing])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(commits).to.deep.equal([])
    await root.fiber.dispose()
  })

  it('fires the commit of the restart it waited for', async () => {
    const root = new Context()
    const commits: number[] = []
    const fiber = await root.plugin((ctx: Context, config: { value: number }) => {
      ctx.on('internal/update', async (config: { value: number }, next: () => Promise<void>) => {
        ctx.fiber.whenStable(config, () => commits.push(config.value))
        // the restart this call waits for is the one it must survive: `next()`
        // unloads the generation that registered the commit
        await next()
      })
    }, { value: 0 })

    await fiber.update({ value: 1 })
    expect(commits).to.deep.equal([1])
    await root.fiber.dispose()
  })
  it('flushes on the vetoing path', async () => {
    const root = new Context()
    const commits: number[] = []
    const fiber = await root.plugin((ctx: Context, config: { value: number }) => {
      ctx.on('internal/update', (config: { value: number }) => {
        ctx.fiber.whenStable(config, () => commits.push(config.value))
        // veto: nothing to await
      })
    }, { value: 0 })

    await fiber.update({ value: 1 })
    expect(commits).to.deep.equal([1])
    await root.fiber.dispose()
  })
})
