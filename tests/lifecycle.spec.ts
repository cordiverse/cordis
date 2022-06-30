import { Context } from '../src'
import * as jest from 'jest-mock'
import { expect } from 'chai'
import { noop } from 'cosmokit'

describe('Lifecycle', () => {
  it('basic support', async () => {
    const root = new Context()
    const callback = jest.fn(noop)
    const { length } = root.state.disposables

    root.on('ready', callback)
    expect(callback.mock.calls).to.have.length(0)

    await root.start()
    expect(callback.mock.calls).to.have.length(1)

    root.on('ready', callback)
    expect(callback.mock.calls).to.have.length(2)

    await root.stop()

    await root.start()
    expect(callback.mock.calls).to.have.length(2)
    expect(root.state.disposables.length).to.equal(length)
  })
})
