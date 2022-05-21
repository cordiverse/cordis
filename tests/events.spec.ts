import { App, Filter } from '../src'
import { expect } from 'chai'
import * as jest from 'jest-mock'
import { noop } from 'cosmokit'

declare module '../src/lifecycle' {
  interface Events {
    'attach'(): void
  }

  namespace Lifecycle {
    interface Session {
      flag: boolean
    }
  }
}

const app = new App({ maxListeners: 64 })
const warn = jest.fn()

app.on('logger/warn', warn)

const filter: Filter = session => session.flag

export function createArray<T>(length: number, create: (index: number) => T) {
  return [...new Array(length).keys()].map(create)
}

describe('Basic Support', () => {
  const extraCalls = 7

  beforeEach(() => warn.mockClear())
  afterEach(() => delete app.lifecycle._hooks.attach)

  it('max hooks', async () => {
    createArray(64 + extraCalls, () => app.on('attach', noop))
    expect(app.lifecycle._hooks.attach.length).to.equal(64 + extraCalls)
    expect(warn.mock.calls).to.have.length(extraCalls)
  })

  it('max prepended hooks', () => {
    createArray(64 + extraCalls, () => app.on('attach', noop, true))
    expect(app.lifecycle._hooks.attach.length).to.equal(64 + extraCalls)
    expect(warn.mock.calls).to.have.length(extraCalls)
  })
})

describe('Hook API', () => {
  const event = 'attach'

  beforeEach(() => {
    delete app.lifecycle._hooks[event]
  })

  it('context.prototype.parallel', async () => {
    await app.parallel(event)
    const callback = jest.fn<void, []>()
    app.intersect(filter).on(event, callback)
    await app.parallel(event)
    expect(callback.mock.calls).to.have.length(1)
    await app.parallel({ flag: false }, event)
    expect(callback.mock.calls).to.have.length(1)
    await app.parallel({ flag: true }, event)
    expect(callback.mock.calls).to.have.length(2)
  })

  it('context.prototype.emit', async () => {
    app.emit(event)
    const callback = jest.fn<void, []>()
    app.intersect(filter).on(event, callback)
    app.emit(event)
    expect(callback.mock.calls).to.have.length(1)
    app.emit({ flag: false }, event)
    expect(callback.mock.calls).to.have.length(1)
    app.emit({ flag: true }, event)
    expect(callback.mock.calls).to.have.length(2)
  })

  it('context.prototype.serial', async () => {
    app.serial(event)
    const callback = jest.fn<void, []>()
    app.intersect(filter).on(event, callback)
    app.serial(event)
    expect(callback.mock.calls).to.have.length(1)
    app.serial({ flag: false }, event)
    expect(callback.mock.calls).to.have.length(1)
    app.serial({ flag: true }, event)
    expect(callback.mock.calls).to.have.length(2)
  })

  it('context.prototype.bail', async () => {
    app.bail(event)
    const callback = jest.fn<void, []>()
    app.intersect(filter).on(event, callback)
    app.bail(event)
    expect(callback.mock.calls).to.have.length(1)
    app.bail({ flag: false }, event)
    expect(callback.mock.calls).to.have.length(1)
    app.bail({ flag: true }, event)
    expect(callback.mock.calls).to.have.length(2)
  })
})
