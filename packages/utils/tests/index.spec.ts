import { describe, it } from 'vitest'
import { Context } from 'cordis'
import assert from 'node:assert'
import { List } from '../src/index.js'

describe('List', () => {
  it('supports push and iteration', () => {
    const ctx = new Context()
    const list = new List(ctx, 'test')
    list.push('a')
    list.push('b')
    assert.strictEqual(list.length, 2)
    assert.deepStrictEqual([...list], ['a', 'b'])
  })

  it('does not leak entries across fiber reloads', async () => {
    const ctx = new Context()
    let list: List<string> | undefined
    const fiber = ctx.plugin((sub) => {
      list ??= new List(sub, 'test')
      list.push('a')
      list.push('b')
    })
    await fiber
    assert.deepStrictEqual([...list!], ['a', 'b'])
    assert.strictEqual(list!.length, 2)

    // Reloading the fiber unloads every pushed entry (its disposer runs) and
    // then re-runs the plugin callback. Each entry's disposer must remove
    // exactly the entry it created — otherwise stale entries accumulate.
    fiber.update({})
    await fiber
    assert.deepStrictEqual([...list!], ['a', 'b'])
    assert.strictEqual(list!.length, 2)

    fiber.update({})
    await fiber
    assert.deepStrictEqual([...list!], ['a', 'b'])
    assert.strictEqual(list!.length, 2)
  })
})
