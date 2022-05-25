import { App } from '../src'
import * as jest from 'jest-mock'
import { expect } from 'chai'

describe('Lifecycle', () => {
  it('basic support', async () => {
    const app = new App()
    const callback = jest.fn(() => {})

    app.on('ready', callback)
    expect(callback.mock.calls).to.have.length(0)

    await app.start()
    expect(callback.mock.calls).to.have.length(1)

    app.on('ready', callback)
    expect(callback.mock.calls).to.have.length(2)

    await app.stop()
  })
})
