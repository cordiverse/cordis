import { App } from '../src'
import * as jest from 'jest-mock'
import { expect } from 'chai'
import { noop } from 'cosmokit'

describe('Lifecycle', () => {
  it('basic support', async () => {
    const app = new App()
    const callback = jest.fn(noop)
    const { length } = app.state.disposables

    app.on('ready', callback)
    expect(callback.mock.calls).to.have.length(0)

    await app.start()
    expect(callback.mock.calls).to.have.length(1)

    app.on('ready', callback)
    expect(callback.mock.calls).to.have.length(2)

    await app.stop()

    await app.start()
    expect(callback.mock.calls).to.have.length(2)
    expect(app.state.disposables.length).to.equal(length)
  })
})
