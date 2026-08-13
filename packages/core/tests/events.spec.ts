import { Context, Events } from '../src'
import { expect, describe, it } from 'vitest'
import { mock } from 'node:test'
import { event, Filter, Session } from './utils'

export function createArray<T>(length: number, create: (index: number) => T) {
  return [...new Array(length).keys()].map(create)
}

function setup() {
  const root = new Context()
  const warn = mock.fn()
  ;(root.logger as any).warn = warn
  return { root, warn }
}

describe('Events', () => {
  it('supports symbol event names across dispatch modes', async () => {
    const { root } = setup()
    const event = Symbol('event')
    const callback = mock.fn((value: number) => value)
    const dispose = root.on(event, callback)

    root.emit(event, 1)
    expect(root.bail(event, 2)).to.equal(2)
    expect(await root.serial(event, 3)).to.equal(3)
    await root.parallel(event, 4)
    expect(callback.mock.calls.map(call => call.arguments[0])).to.deep.equal([1, 2, 3, 4])

    dispose()
    root.emit(event, 5)
    expect(callback.mock.calls).to.have.length(4)
  })

  it('supports symbol event names with ctx.once()', () => {
    const { root } = setup()
    const event = Symbol('once')
    const callback = mock.fn()
    root.once(event, callback)

    root.emit(event)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('treats prototype property names as ordinary events', () => {
    const { root } = setup()

    // dispatching an unregistered name must not reach `Object.prototype`
    expect(() => root.emit('toString')).to.not.throw()

    for (const name of ['__proto__', 'toString', 'constructor'] as const) {
      const callback = mock.fn()
      const dispose = root.on(name, callback)

      root.emit(name)
      expect(callback.mock.calls, name).to.have.length(1)
      dispose()
      root.emit(name)
      expect(callback.mock.calls, name).to.have.length(1)
      expect(Reflect.has(root.events._hooks, name), name).to.be.false
    }
  })

  it('removes empty event buckets after disposal', () => {
    const { root } = setup()
    const event = Symbol('temporary')
    const first = root.on(event, () => {})
    const second = root.on(event, () => {})

    first()
    expect(Reflect.has(root.events._hooks, event)).to.be.true
    second()
    expect(Reflect.has(root.events._hooks, event)).to.be.false
  })

  it('ctx.on()', async () => {
    const { root } = setup()
    const callback = mock.fn()
    const dispose = root.on(event, callback)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(2)
    dispose()
    root.emit(event)
    expect(callback.mock.calls).to.have.length(2)
  })

  it('ctx.once()', async () => {
    const { root } = setup()
    const callback = mock.fn()
    const dispose = root.once(event, callback)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    dispose()
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('ctx.parallel()', async () => {
    const { root } = setup()
    await root.parallel(event)
    const callback = mock.fn()
    root.extend(new Filter(true)).on(event, callback)

    await root.parallel(event)
    expect(callback.mock.calls).to.have.length(1)
    await root.parallel(new Session(false), event)
    expect(callback.mock.calls).to.have.length(1)
    await root.parallel(new Session(true), event)
    expect(callback.mock.calls).to.have.length(2)

    // a rejecting listener must not short-circuit the others
    let settled = false
    const dispose = root.on(event, async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
      settled = true
      throw new Error('async')
    })
    callback.mock.mockImplementation(() => {
      throw new Error('test')
    })
    const error = await root.parallel(event).catch(e => e)
    expect(error).to.be.instanceof(AggregateError)
    expect(error.errors.map((e: Error) => e.message)).to.have.members(['test', 'async'])
    expect(settled).to.be.true
    dispose()
  })

  it('ctx.emit()', async () => {
    const { root } = setup()
    root.emit(event)
    const callback = mock.fn()
    root.extend(new Filter(true)).on(event, callback)

    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    root.emit(new Session(false), event)
    expect(callback.mock.calls).to.have.length(1)
    root.emit(new Session(true), event)
    expect(callback.mock.calls).to.have.length(2)

    callback.mock.mockImplementation(() => {
      throw new Error('test')
    })
    expect(() => root.emit(event)).to.throw('test')
  })

  it('ctx.serial()', async () => {
    const { root } = setup()
    root.serial(event)
    const callback = mock.fn()
    root.extend(new Filter(true)).on(event, callback)

    root.serial(event)
    expect(callback.mock.calls).to.have.length(1)
    root.serial(new Session(false), event)
    expect(callback.mock.calls).to.have.length(1)
    root.serial(new Session(true), event)
    expect(callback.mock.calls).to.have.length(2)

    callback.mock.mockImplementation(() => {
      throw new Error('message')
    })
    await expect(root.serial(event)).rejects.toThrow('message')
  })

  it('ctx.bail()', async () => {
    const { root } = setup()
    root.bail(event)
    const callback = mock.fn()
    root.extend(new Filter(true)).on(event, callback)

    root.bail(event)
    expect(callback.mock.calls).to.have.length(1)
    root.bail(new Session(false), event)
    expect(callback.mock.calls).to.have.length(1)
    root.bail(new Session(true), event)
    expect(callback.mock.calls).to.have.length(2)

    callback.mock.mockImplementation(() => {
      throw new Error('message')
    })
    expect(() => root.bail(event)).to.throw('message')
  })

  it('ctx.waterfall()', async () => {
    const { root } = setup()
    const cb1 = mock.fn<Events['test/waterfall']>((value, next) => value + next())
    root.on('test/waterfall', cb1)
    const cb2 = mock.fn<Events['test/waterfall']>((value, next) => value + next())
    root.on('test/waterfall', cb2)

    expect(root.waterfall('test/waterfall', 1, () => 2)).to.equal(4)
    expect(cb1.mock.calls).to.have.length(1)
    expect(cb2.mock.calls).to.have.length(1)
    cb1.mock.resetCalls()
    cb2.mock.resetCalls()

    const cb3 = mock.fn<Events['test/waterfall']>((value, next) => value)
    root.on('test/waterfall', cb3)
    const cb4 = mock.fn<Events['test/waterfall']>((value, next) => value + next())
    root.on('test/waterfall', cb4)
    expect(root.waterfall('test/waterfall', 1, () => 2)).to.equal(3)
    expect(cb1.mock.calls).to.have.length(1)
    expect(cb2.mock.calls).to.have.length(1)
    expect(cb3.mock.calls).to.have.length(1)
    expect(cb4.mock.calls).to.have.length(0)
    cb1.mock.resetCalls()
    cb2.mock.resetCalls()
    cb3.mock.resetCalls()
    cb4.mock.resetCalls()
  })

  it('ctx.waterfall() rejects duplicate next()', async () => {
    const { root } = setup()
    const terminal = mock.fn(() => 2)
    const callback = mock.fn<Events['test/waterfall']>((value, next) => {
      const result = next()
      expect(() => next()).to.throw('next() called multiple times')
      return value + result
    })
    root.on('test/waterfall', callback)

    expect(root.waterfall('test/waterfall', 1, terminal)).to.equal(3)
    expect(callback.mock.calls).to.have.length(1)
    expect(terminal.mock.calls).to.have.length(1)
  })

  it('ctx.waterfall() supports nested async calls', async () => {
    const { root } = setup()
    const terminal = mock.fn(() => 2)
    const callback = mock.fn(async (value: number, next: () => number) => {
      await Promise.resolve()
      const result = next()
      if (value === 1) {
        return result + await root.waterfall('test/waterfall', 2, terminal)
      }
      return result
    })
    root.on('test/waterfall', callback as any)

    expect(await root.waterfall('test/waterfall', 1, terminal)).to.equal(4)
    expect(callback.mock.calls).to.have.length(2)
    expect(terminal.mock.calls).to.have.length(2)
  })
})
