import { DisposableList } from '../src/index.ts'
import { expect, describe, it } from 'vitest'

describe('DisposableList', () => {
  const a = { name: 'a' }
  const b = { name: 'b' }
  const c = { name: 'c' }
  const d = { name: 'd' }

  it('iterates unshifted entries before pushed ones', () => {
    const list = new DisposableList()
    list.push(a)
    list.unshift(b)
    list.push(c)
    list.unshift(d)
    expect([...list]).to.deep.equal([d, b, a, c])
    expect(list.length).to.equal(4)
  })

  it('disposer removes its own entry after a later push', () => {
    const list = new DisposableList()
    const disposeA = list.push(a)
    const disposeB = list.push(b)

    disposeA()
    expect([...list]).to.deep.equal([b])

    disposeB()
    expect([...list]).to.deep.equal([])
  })

  it('disposer removes its own entry after a later unshift', () => {
    const list = new DisposableList()
    const disposeA = list.unshift(a)
    const disposeB = list.unshift(b)

    disposeA()
    expect([...list]).to.deep.equal([b])

    disposeB()
    expect([...list]).to.deep.equal([])
  })

  it('delete removes the entry it was given', () => {
    const list = new DisposableList()
    list.push(a)
    list.push(b)

    expect(list.delete(a)).to.equal(true)
    expect([...list]).to.deep.equal([b])
    expect(list.delete(a)).to.equal(false)
  })

  it('delete removes an unshifted entry', () => {
    const list = new DisposableList()
    list.push(a)
    list.unshift(b)

    expect(list.delete(b)).to.equal(true)
    expect([...list]).to.deep.equal([a])
    expect(list.delete(b)).to.equal(false)
  })

  it('clear removes every entry and returns them in order', () => {
    const list = new DisposableList()
    list.push(a)
    list.unshift(b)

    expect(list.clear()).to.deep.equal([b, a])
    expect([...list]).to.deep.equal([])
    expect(list.length).to.equal(0)
  })
})
