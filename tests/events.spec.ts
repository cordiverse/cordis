import { App, Filter } from '../src'
import { expect } from 'chai'
import * as jest from 'jest-mock'

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

const app = new App()

const filter: Filter = session => session.flag

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
