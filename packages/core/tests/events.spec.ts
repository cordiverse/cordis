import { Context } from '../src'
import { expect } from 'chai'
import { describe, mock, test } from 'node:test'
import { noop } from 'cosmokit'
import { event, Filter, Session } from './utils'

export function createArray<T>(length: number, create: (index: number) => T) {
  return [...new Array(length).keys()].map(create)
}

function setup() {
  const root = new Context()
  const warn = mock.fn()
  root.on('internal/warning', warn)
  return { root, warn }
}

describe('Event Listener', () => {
  test('context.prototype.on', () => {
    const { root } = setup()
    const callback = mock.fn()
    const dispose = root.on(event, callback)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(2)
    expect(dispose()).to.be.ok
    root.emit(event)
    expect(callback.mock.calls).to.have.length(2)
  })

  test('context.prototype.once', () => {
    const { root } = setup()
    const callback = mock.fn()
    const dispose = root.once(event, callback)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    expect(dispose()).to.be.not.ok
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  test('context.prototype.off', () => {
    const { root } = setup()
    const callback = mock.fn()
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
  test('context.prototype.parallel', async () => {
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

  test('context.prototype.emit', async () => {
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

  test('context.prototype.serial', async () => {
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

  test('context.prototype.bail', async () => {
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
})
