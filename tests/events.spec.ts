import { App } from '../src'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import { noop } from 'cosmokit'
import { event, filter } from './shared'

export function createArray<T>(length: number, create: (index: number) => T) {
  return [...new Array(length).keys()].map(create)
}

function setup() {
  const app = new App({ maxListeners: 64 })
  const warn = jest.fn()
  app.on('logger/warn', warn)
  return { app, warn }
}

describe('Event Listener', () => {
  const extraCalls = 7

  it('max appended hooks', async () => {
    const { app, warn } = setup()
    createArray(64 + extraCalls, () => app.on(event, noop))
    expect(app.lifecycle._hooks[event].length).to.equal(64 + extraCalls)
    expect(warn.mock.calls).to.have.length(extraCalls)
  })

  it('max prepended hooks', () => {
    const { app, warn } = setup()
    createArray(64 + extraCalls, () => app.before('custom', noop))
    expect(app.lifecycle._hooks['before-custom'].length).to.equal(64 + extraCalls)
    expect(warn.mock.calls).to.have.length(extraCalls)
  })

  it('context.prototype.on', () => {
    const { app } = setup()
    const callback = jest.fn()
    const dispose = app.on(event, callback)
    app.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    app.emit(event)
    expect(callback.mock.calls).to.have.length(2)
    expect(dispose()).to.be.ok
    app.emit(event)
    expect(callback.mock.calls).to.have.length(2)
  })

  it('context.prototype.once', () => {
    const { app } = setup()
    const callback = jest.fn()
    const dispose = app.once(event, callback)
    app.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    app.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    expect(dispose()).to.be.not.ok
    app.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('context.prototype.off', () => {
    const { app } = setup()
    const callback = jest.fn()
    app.on(event, callback)
    app.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    expect(app.off(event, callback)).to.be.ok
    app.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    expect(app.off(event, callback)).to.be.not.ok
  })
})

describe('Events Emitter', () => {
  it('context.prototype.parallel', async () => {
    const { app, warn } = setup()
    await app.parallel(event)
    const callback = jest.fn()
    app.intersect(filter).on(event, callback)

    await app.parallel(event)
    expect(callback.mock.calls).to.have.length(1)
    await app.parallel({ flag: false }, event)
    expect(callback.mock.calls).to.have.length(1)
    await app.parallel({ flag: true }, event)
    expect(callback.mock.calls).to.have.length(2)

    callback.mockImplementation(() => {
      throw new Error('test')
    })
    expect(warn.mock.calls).to.have.length(0)
    await app.parallel(event)
    expect(warn.mock.calls).to.have.length(1)
  })

  it('context.prototype.emit', async () => {
    const { app, warn } = setup()
    app.emit(event)
    const callback = jest.fn()
    app.intersect(filter).on(event, callback)

    app.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    app.emit({ flag: false }, event)
    expect(callback.mock.calls).to.have.length(1)
    app.emit({ flag: true }, event)
    expect(callback.mock.calls).to.have.length(2)

    callback.mockImplementation(() => {
      throw new Error('test')
    })
    expect(warn.mock.calls).to.have.length(0)
    app.emit(event)
    expect(warn.mock.calls).to.have.length(1)
  })

  it('context.prototype.serial', async () => {
    const { app } = setup()
    app.serial(event)
    const callback = jest.fn()
    app.intersect(filter).on(event, callback)

    app.serial(event)
    expect(callback.mock.calls).to.have.length(1)
    app.serial({ flag: false }, event)
    expect(callback.mock.calls).to.have.length(1)
    app.serial({ flag: true }, event)
    expect(callback.mock.calls).to.have.length(2)

    callback.mockImplementation(() => {
      throw new Error('message')
    })
    await expect(app.serial(event)).to.be.rejectedWith('message')
  })

  it('context.prototype.bail', async () => {
    const { app } = setup()
    app.bail(event)
    const callback = jest.fn()
    app.intersect(filter).on(event, callback)

    app.bail(event)
    expect(callback.mock.calls).to.have.length(1)
    app.bail({ flag: false }, event)
    expect(callback.mock.calls).to.have.length(1)
    app.bail({ flag: true }, event)
    expect(callback.mock.calls).to.have.length(2)

    callback.mockImplementation(() => {
      throw new Error('message')
    })
    expect(() => app.bail(event)).to.throw('message')
  })
})
