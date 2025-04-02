import { Context } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'
import { sleep, withTimers } from './utils'

describe('Effects', () => {
  it('dispose by plugin', async () => {
    const root = new Context()
    const dispose = mock.fn()
    const fiber = await root.plugin((ctx) => {
      ctx.effect(() => dispose, 'test')
    })
    expect(fiber.getEffects()).to.deep.equal([
      { label: 'test', children: [] },
    ])
    expect(dispose.mock.calls).to.have.length(0)
    await fiber.dispose()
    expect(dispose.mock.calls).to.have.length(1)
    await fiber.dispose()
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('dispose manually', async () => {
    const root = new Context()
    const dispose1 = mock.fn()
    const dispose2 = root.effect(() => dispose1)
    expect(root.fiber.getEffects()).to.deep.equal([
      { label: 'anonymous', children: [] },
    ])
    expect(dispose1.mock.calls).to.have.length(0)
    dispose2()
    expect(dispose1.mock.calls).to.have.length(1)
    dispose2()
    expect(dispose1.mock.calls).to.have.length(1)
  })

  it('yield dispose', async () => {
    const root = new Context()
    const seq: number[] = []
    const dispose1 = mock.fn(() => seq.push(1))
    const dispose2 = mock.fn(() => seq.push(2))
    const dispose3 = mock.fn(() => seq.push(3))
    const dispose = root.effect(function* () {
      yield dispose1
      yield root.on('internal/service', () => {})
      yield dispose2
      yield root.effect(function* () {
        yield root.on('internal/before-service', () => {})
        yield dispose3
      })
    })
    root.on('custom-event', () => {})
    expect(root.fiber.getEffects()).to.deep.equal([
      {
        label: 'anonymous',
        children: [
          // only root level anonymous effects are included
          { label: 'ctx.on("internal/service")', children: [] },
          {
            label: 'anonymous',
            children: [
              { label: 'ctx.on("internal/before-service")', children: [] },
            ],
          },
        ],
      },
      { label: 'ctx.on("custom-event")', children: [] },
    ])
    expect(seq).to.deep.equal([])
    dispose()
    expect(seq).to.deep.equal([3, 2, 1])
    dispose()
    expect(seq).to.deep.equal([3, 2, 1])
  })

  it('async return 1', withTimers(async (root, clock) => {
    const seq: number[] = []
    const dispose = root.effect(async () => {
      await sleep(100)
      seq.push(1)
      return () => seq.push(2)
    })
    expect(seq).to.deep.equal([])
    await clock.tickAsync(100)
    expect(seq).to.deep.equal([1])
    await dispose()
    expect(seq).to.deep.equal([1, 2])
  }))

  it('async return 2', withTimers(async (root, clock) => {
    const seq: number[] = []
    const dispose = root.effect(async () => {
      await sleep(100)
      seq.push(1)
      return () => seq.push(2)
    })
    dispose()
    expect(seq).to.deep.equal([])
    await clock.tickAsync(100)
    expect(seq).to.deep.equal([1, 2])
  }))

  it('async yield 1', withTimers(async (root, clock) => {
    const seq: number[] = []
    const dispose = root.effect(async function* () {
      await sleep(100)
      seq.push(1)
      yield () => seq.push(2)
      await sleep(100)
      seq.push(3)
      yield () => seq.push(4)
      await sleep(100)
      seq.push(5)
      yield () => seq.push(6)
    })
    expect(seq).to.deep.equal([])
    await clock.tickAsync(300)
    expect(seq).to.deep.equal([1, 3, 5])
    await dispose()
    expect(seq).to.deep.equal([1, 3, 5, 6, 4, 2])
  }))

  it('async yield 2 (aborted)', withTimers(async (root, clock) => {
    const seq: number[] = []
    const dispose = root.effect(async function* () {
      await sleep(100)
      seq.push(1)
      yield () => seq.push(2)
      await sleep(100)
      seq.push(3)
      yield () => seq.push(4)
      await sleep(100)
      seq.push(5)
      yield () => seq.push(6)
    })
    await clock.tickAsync(50)
    dispose()
    expect(seq).to.deep.equal([])
    await clock.tickAsync(300)
    expect(seq).to.deep.equal([1, 2])
  }))

  it('async yield 3 (aborted)', withTimers(async (root, clock) => {
    const seq: number[] = []
    const dispose = root.effect(async function* () {
      await sleep(100)
      seq.push(1)
      yield () => seq.push(2)
      await sleep(100)
      seq.push(3)
      yield () => seq.push(4)
      await sleep(100)
      seq.push(5)
      yield () => seq.push(6)
    })
    expect(seq).to.deep.equal([])
    await clock.tickAsync(100)
    expect(seq).to.deep.equal([1])
    dispose()
    expect(seq).to.deep.equal([1])
    await clock.tickAsync(200)
    expect(seq).to.deep.equal([1, 3, 4, 2])
  }))

  it('async yield 4 (await dispose)', withTimers(async (root, clock) => {
    const seq: number[] = []
    const dispose = root.effect(async function* () {
      await sleep(100)
      seq.push(1)
      yield () => seq.push(2)
      await sleep(100)
      seq.push(3)
      yield () => seq.push(4)
      await sleep(100)
      seq.push(5)
      yield () => seq.push(6)
    })
    expect(seq).to.deep.equal([])
    const [dispose2] = await Promise.all([dispose, clock.tickAsync(300)])
    expect(seq).to.deep.equal([1, 3, 5])
    await dispose2()
    expect(seq).to.deep.equal([1, 3, 5, 6, 4, 2])
  }))

  it('return with error', async () => {
    const root = new Context()
    const seq: number[] = []
    expect(() => {
      root.effect(() => {
        throw new Error('test')
        return () => seq.push(1)
      })
    }).to.throw('test')
    expect(seq).to.deep.equal([])
  })

  it('yield with error', async () => {
    const root = new Context()
    const seq: number[] = []
    expect(() => {
      root.effect(function* () {
        yield () => seq.push(1)
        throw new Error('test')
        yield () => seq.push(2)
      })
    }).to.throw('test')
    expect(seq).to.deep.equal([1])
  })

  it('async return with error', async () => {
    const root = new Context()
    const seq: number[] = []
    const dispose = root.effect(async () => {
      throw new Error('test')
      return () => seq.push(1)
    })
    expect(seq).to.deep.equal([])
    await expect(dispose).to.be.rejected
    expect(seq).to.deep.equal([])
  })

  it('async yield with error', async () => {
    const root = new Context()
    const seq: number[] = []
    const dispose = root.effect(async function* () {
      yield () => seq.push(1)
      throw new Error('test')
      yield () => seq.push(2)
    })
    expect(seq).to.deep.equal([])
    await expect(dispose).to.be.rejected
    expect(seq).to.deep.equal([1])
  })
})
