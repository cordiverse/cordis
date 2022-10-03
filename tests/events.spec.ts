import { Context } from '../src'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import { noop } from 'cosmokit'
import { event, Filter, Session } from './utils'

export function createArray<T>(length: number, create: (index: number) => T) {
  return [...new Array(length).keys()].map(create)
}

function setup() {
  const root = new Context({ maxListeners: 64 })
  expect(root.config).to.deep.equal({ maxListeners: 64 })
  const warn = jest.fn()
  root.on('internal/warning', warn)
  return { root, warn }
}

describe('Event Listener', () => {
  const extraCalls = 7

  it('max appended hooks', async () => {
    const { root, warn } = setup()
    createArray(64 + extraCalls, () => root.on(event, noop))
    expect(root.events._hooks[event].length).to.equal(64 + extraCalls)
    expect(warn.mock.calls).to.have.length(extraCalls)
  })

  it('context.prototype.on', () => {
    const { root } = setup()
    const callback = jest.fn()
    const dispose = root.on(event, callback)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(2)
    expect(dispose()).to.be.ok
    root.emit(event)
    expect(callback.mock.calls).to.have.length(2)
  })

  it('context.prototype.once', () => {
    const { root } = setup()
    const callback = jest.fn()
    const dispose = root.once(event, callback)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    expect(dispose()).to.be.not.ok
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('context.prototype.off', () => {
    const { root } = setup()
    const callback = jest.fn()
    root.on(event, callback)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    expect(root.off(event, callback)).to.be.ok
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    expect(root.off(event, callback)).to.be.not.ok
  })
})

describe('Events Emitter', () => {
  it('context.prototype.parallel', async () => {
    const { root, warn } = setup()
    await root.parallel(event)
    const callback = jest.fn()
    root.extend(new Filter(true)).on(event, callback)

    await root.parallel(event)
    expect(callback.mock.calls).to.have.length(1)
    await root.parallel(new Session(false), event)
    expect(callback.mock.calls).to.have.length(1)
    await root.parallel(new Session(true), event)
    expect(callback.mock.calls).to.have.length(2)

    callback.mockImplementation(() => {
      throw new Error('test')
    })
    expect(warn.mock.calls).to.have.length(0)
    await root.parallel(event)
    expect(warn.mock.calls).to.have.length(1)
  })

  it('context.prototype.emit', async () => {
    const { root, warn } = setup()
    root.emit(event)
    const callback = jest.fn()
    root.extend(new Filter(true)).on(event, callback)

    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    root.emit(new Session(false), event)
    expect(callback.mock.calls).to.have.length(1)
    root.emit(new Session(true), event)
    expect(callback.mock.calls).to.have.length(2)

    callback.mockImplementation(() => {
      throw new Error('test')
    })
    expect(warn.mock.calls).to.have.length(0)
    root.emit(event)
    expect(warn.mock.calls).to.have.length(1)
  })

  it('context.prototype.serial', async () => {
    const { root } = setup()
    root.serial(event)
    const callback = jest.fn()
    root.extend(new Filter(true)).on(event, callback)

    root.serial(event)
    expect(callback.mock.calls).to.have.length(1)
    root.serial(new Session(false), event)
    expect(callback.mock.calls).to.have.length(1)
    root.serial(new Session(true), event)
    expect(callback.mock.calls).to.have.length(2)

    callback.mockImplementation(() => {
      throw new Error('message')
    })
    await expect(root.serial(event)).to.be.rejectedWith('message')
  })

  it('context.prototype.bail', async () => {
    const { root } = setup()
    root.bail(event)
    const callback = jest.fn()
    root.extend(new Filter(true)).on(event, callback)

    root.bail(event)
    expect(callback.mock.calls).to.have.length(1)
    root.bail(new Session(false), event)
    expect(callback.mock.calls).to.have.length(1)
    root.bail(new Session(true), event)
    expect(callback.mock.calls).to.have.length(2)

    callback.mockImplementation(() => {
      throw new Error('message')
    })
    expect(() => root.bail(event)).to.throw('message')
  })
})
