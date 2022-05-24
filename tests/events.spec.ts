import { App, Filter } from '../src'
import { expect, use } from 'chai'
import * as jest from 'jest-mock'
import { noop } from 'cosmokit'
import promised from 'chai-as-promised'

use(promised)

const event = Symbol('custom-event')

declare module '../src/lifecycle' {
  interface Events {
    [event](): void
  }

  namespace Lifecycle {
    interface Session {
      flag: boolean
    }
  }
}

const filter: Filter = session => session.flag

export function createArray<T>(length: number, create: (index: number) => T) {
  return [...new Array(length).keys()].map(create)
}

function setup() {
  const app = new App({ maxListeners: 64 })
  const warn = jest.fn()
  app.on('logger/warn', warn)
  return { app, warn }
}

describe('Basic Support', () => {
  const extraCalls = 7

  it('max appended hooks', async () => {
    const { app, warn } = setup()
    createArray(64 + extraCalls, () => app.on(event, noop))
    expect(app.lifecycle._hooks[event].length).to.equal(64 + extraCalls)
    expect(warn.mock.calls).to.have.length(extraCalls)
  })

  it('max prepended hooks', () => {
    const { app, warn } = setup()
    createArray(64 + extraCalls, () => app.on(event, noop, true))
    expect(app.lifecycle._hooks[event].length).to.equal(64 + extraCalls)
    expect(warn.mock.calls).to.have.length(extraCalls)
  })
})

describe('Hook API', () => {
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
