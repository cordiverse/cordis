import { DisposableList } from '../src/index.ts'
import { expect, describe, it } from 'vitest'

describe('DisposableList', () => {
  it('disposer removes its own entry after a later push', () => {
    const list = new DisposableList()
    const a = { name: 'a' }
    const b = { name: 'b' }
    const disposeA = list.push(a)
    const disposeB = list.push(b)

    disposeA()
    expect([...list]).to.deep.equal([b])

    disposeB()
    expect([...list]).to.deep.equal([])
  })

  it('delete removes the entry it was given', () => {
    const list = new DisposableList()
    const a = { name: 'a' }
    const b = { name: 'b' }
    list.push(a)
    list.push(b)

    expect(list.delete(a)).to.equal(true)
    expect([...list]).to.deep.equal([b])
    expect(list.delete(a)).to.equal(false)
  })
})
