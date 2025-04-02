import { Context, Events } from '../src'
import { expect } from 'chai'
import { mock } from 'node:test'
import { event, Filter, Session } from './utils'

export function createArray<T>(length: number, create: (index: number) => T) {
  return [...new Array(length).keys()].map(create)
}

function setup() {
  const root = new Context()
  const warn = mock.fn()
  root.on('internal/warn', warn)
  return { root, warn }
}

describe('Events', () => {
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

    callback.mock.mockImplementation(() => {
      throw new Error('test')
    })
    await expect(root.parallel(event)).to.be.rejectedWith('test')
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
    await expect(root.serial(event)).to.be.rejectedWith('message')
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
})
