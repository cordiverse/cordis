import { Include } from '../src/index.ts'
import { describe, expect, it, vi } from 'vitest'

function createInclude() {
  const include = Object.create(Include.prototype) as Include
  const logger = { warn: vi.fn() }
  Object.assign(include, {
    filename: '/tmp/cordis-include-test.yml',
    writeQueue: Promise.resolve(),
    ctx: {
      emit: vi.fn(),
      root: {
        logger: () => logger,
      },
    },
    root: {
      data: [],
      stop: vi.fn(),
    },
  })
  return { include, logger }
}

describe('Include writes', () => {
  it('serializes debounced writes', async () => {
    const { include } = createInclude()
    const firstStarted = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const writes: string[] = []
    let active = 0
    let maxActive = 0

    ;(include as any)._writeFile = vi.fn(async (config: { id: string }[]) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      writes.push(config[0].id)
      if (writes.length === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
      }
      active -= 1
    })

    include.root.data = [{ id: 'first', name: 'first' }]
    include.write()
    await firstStarted.promise

    include.root.data = [{ id: 'second', name: 'second' }]
    include.write()
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(writes).toEqual(['first'])
    releaseFirst.resolve()
    await include.stop()

    expect(writes).toEqual(['first', 'second'])
    expect(maxActive).toBe(1)
  })

  it('flushes the latest debounced write before stopping', async () => {
    const { include } = createInclude()
    const writeStarted = Promise.withResolvers<void>()
    const releaseWrite = Promise.withResolvers<void>()

    ;(include as any)._writeFile = vi.fn(async () => {
      writeStarted.resolve()
      await releaseWrite.promise
    })

    include.root.data = [{ id: 'pending', name: 'pending' }]
    include.write()

    let stopped = false
    const stopTask = include.stop().then(() => { stopped = true })
    await writeStarted.promise
    await Promise.resolve()

    expect(stopped).toBe(false)
    releaseWrite.resolve()
    await stopTask
    expect(include.root.stop).toHaveBeenCalledOnce()
  })

  it('logs asynchronous failures and rethrows them on stop', async () => {
    const { include, logger } = createInclude()
    const error = new Error('write failed')
    const writeStarted = Promise.withResolvers<void>()
    ;(include as any)._writeFile = vi.fn(async () => {
      writeStarted.resolve()
      throw error
    })

    include.root.data = [{ id: 'failed', name: 'failed' }]
    include.write()
    await writeStarted.promise
    await expect(include.stop()).rejects.toBe(error)

    expect(logger.warn).toHaveBeenCalledWith('failed to write config file %C', '/tmp/cordis-include-test.yml')
    expect(logger.warn).toHaveBeenCalledWith(error)
  })

  it('continues writing after a failed attempt', async () => {
    const { include } = createInclude()
    const firstStarted = Promise.withResolvers<void>()
    const error = new Error('write failed')
    const write = vi.fn()
      .mockImplementationOnce(async () => {
        firstStarted.resolve()
        throw error
      })
      .mockResolvedValueOnce(undefined)
    ;(include as any)._writeFile = write

    include.root.data = [{ id: 'failed', name: 'failed' }]
    include.write()
    await firstStarted.promise
    await Promise.resolve()

    include.root.data = [{ id: 'recovered', name: 'recovered' }]
    include.write()
    await include.stop()

    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenLastCalledWith([{ id: 'recovered', name: 'recovered' }])
  })
})
