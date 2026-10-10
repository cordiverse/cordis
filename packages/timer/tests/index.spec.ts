import { mock } from 'node:test'
import { describe, it, vi } from 'vitest'
import { Context } from 'cordis'
import assert from 'node:assert'
import Timer from '../src/index.js'

function withContext(callback: (ctx: Context) => any, config?: { now?: number | Date }) {
  return async () => {
    const ctx = new Context()
    vi.useFakeTimers(config)
    await ctx.plugin(Timer)
    try {
      await ctx.plugin({ inject: ['timer'], apply: callback })
    } finally {
      vi.useRealTimers()
    }
  }
}

describe('ctx.timer', () => {
  describe('ctx.timeout()', () => {
    it('basic support', withContext(async (ctx) => {
      const callback = mock.fn()
      ctx.timeout(callback, 1000)
      assert.strictEqual(callback.mock.calls.length, 0)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 1)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 1)
    }))

    it('dispose', withContext(async (ctx) => {
      const callback = mock.fn()
      const dispose = ctx.timeout(callback, 1000)
      assert.strictEqual(callback.mock.calls.length, 0)
      dispose()
      await vi.advanceTimersByTimeAsync(2000)
      assert.strictEqual(callback.mock.calls.length, 0)
    }))

    it('promise', withContext(async (ctx) => {
      const resolve = mock.fn()
      const reject = mock.fn()
      ctx.timeout(1000).then(resolve, reject)
      await vi.advanceTimersByTimeAsync(500)
      assert.strictEqual(resolve.mock.calls.length, 0)
      assert.strictEqual(reject.mock.calls.length, 0)
      await vi.advanceTimersByTimeAsync(500)
      assert.strictEqual(resolve.mock.calls.length, 1)
      assert.strictEqual(reject.mock.calls.length, 0)
      ctx.fiber.dispose()
      await vi.advanceTimersByTimeAsync(2000)
      assert.strictEqual(resolve.mock.calls.length, 1)
      assert.strictEqual(reject.mock.calls.length, 0)
    }))
  })

  describe('ctx.interval()', () => {
    it('basic support', withContext(async (ctx) => {
      const callback = mock.fn()
      const dispose = ctx.interval(callback, 1000)
      assert.strictEqual(callback.mock.calls.length, 0)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 1)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 2)
      dispose()
      await vi.advanceTimersByTimeAsync(2000)
      assert.strictEqual(callback.mock.calls.length, 2)
    }))

    it('async iterator (manual return)', withContext(async (ctx) => {
      const callback = mock.fn()
      const iterator = ctx.interval(1000)
      async function iterate() {
        for await (const _ of iterator) {
          callback()
        }
      }
      const resolve = mock.fn()
      const reject = mock.fn()
      iterate().then(resolve, reject)
      assert.strictEqual(callback.mock.calls.length, 0)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 1)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 2)
      iterator.return!()
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 2)
      assert.strictEqual(resolve.mock.calls.length, 1)
      assert.strictEqual(reject.mock.calls.length, 0)
    }))

    it('async iterator (concurrent reads)', withContext(async (ctx) => {
      const iterator = ctx.interval(1000)
      const first = iterator.next()
      const second = iterator.next()
      const firstResolve = mock.fn()
      const secondResolve = mock.fn()
      first.then(firstResolve)
      second.then(secondResolve)

      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(firstResolve.mock.calls.length, 1)
      assert.strictEqual(secondResolve.mock.calls.length, 0)

      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(firstResolve.mock.calls.length, 1)
      assert.strictEqual(secondResolve.mock.calls.length, 1)
      assert.deepStrictEqual(await Promise.all([first, second]), [
        { done: false, value: undefined },
        { done: false, value: undefined },
      ])
    }))

    it('async iterator (return with concurrent reads)', withContext(async (ctx) => {
      const iterator = ctx.interval<number>(1000)
      const reads = [iterator.next(), iterator.next(), iterator.next()]

      assert.deepStrictEqual(await iterator.return!(42), { done: true, value: 42 })
      assert.deepStrictEqual(await Promise.all(reads), [
        { done: true, value: 42 },
        { done: true, value: 42 },
        { done: true, value: 42 },
      ])
      assert.deepStrictEqual(await iterator.next(), { done: true, value: 42 })
    }))

    it('async iterator (throw with concurrent reads)', withContext(async (ctx) => {
      const iterator = ctx.interval(1000)
      const reads = [iterator.next(), iterator.next(), iterator.next()]
      const reason = new Error('test')

      assert.deepStrictEqual(await iterator.throw!(reason), { done: true, value: undefined })
      await Promise.all(reads.map(read => assert.rejects(read, reason)))
      await assert.rejects(iterator.next(), reason)
    }))

    it('async iterator (manual throw)', withContext(async (ctx) => {
      const callback = mock.fn()
      const iterator = ctx.interval(1000)
      async function iterate() {
        for await (const _ of iterator) {
          callback()
        }
      }
      const resolve = mock.fn()
      const reject = mock.fn()
      iterate().then(resolve, reject)
      assert.strictEqual(callback.mock.calls.length, 0)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 1)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 2)
      iterator.throw!()
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 2)
      assert.strictEqual(resolve.mock.calls.length, 0)
      assert.strictEqual(reject.mock.calls.length, 1)
    }))

    it('async iterator (break return)', withContext(async (ctx) => {
      const callback = mock.fn()
      const iterator = ctx.interval(1000)
      async function iterate() {
        let i = 0
        for await (const _ of iterator) {
          if (++i > 2) break
          callback()
        }
      }
      const resolve = mock.fn()
      const reject = mock.fn()
      iterate().then(resolve, reject)
      assert.strictEqual(callback.mock.calls.length, 0)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 1)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 2)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 2)
      assert.strictEqual(resolve.mock.calls.length, 1)
      assert.strictEqual(reject.mock.calls.length, 0)
    }))

    it('async iterator (break throw)', withContext(async (ctx) => {
      const callback = mock.fn()
      const iterator = ctx.interval(1000)
      async function iterate() {
        let i = 0
        for await (const _ of iterator) {
          if (++i > 2) throw new Error('test')
          callback()
        }
      }
      const resolve = mock.fn()
      const reject = mock.fn()
      iterate().then(resolve, reject)
      assert.strictEqual(callback.mock.calls.length, 0)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 1)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 2)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 2)
      assert.strictEqual(resolve.mock.calls.length, 0)
      assert.strictEqual(reject.mock.calls.length, 1)
    }))

    it('async iterator (context dispose)', withContext(async function* (ctx) {
      const callback = mock.fn()
      const iterator = ctx.interval(1000)
      async function iterate() {
        for await (const _ of iterator) {
          callback()
        }
      }
      const resolve = mock.fn()
      const reject = mock.fn()
      iterate().then(resolve, reject)
      assert.strictEqual(callback.mock.calls.length, 0)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 1)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 2)
      ctx.fiber.dispose()
      yield async () => {
        await vi.advanceTimersByTimeAsync(1000)
        assert.strictEqual(callback.mock.calls.length, 2)
        assert.strictEqual(resolve.mock.calls.length, 0)
        assert.strictEqual(reject.mock.calls.length, 1)
      }
    }))

    it('async iterator (context dispose with concurrent reads)', withContext(async function* (ctx) {
      const iterator = ctx.interval(1000)
      const reads = [iterator.next(), iterator.next(), iterator.next()]
      ctx.fiber.dispose()

      yield async () => {
        for (const read of reads) {
          await assert.rejects(read, { message: 'Context has been disposed' })
        }
      }
    }))
  })

  describe('ctx.throttle()', () => {
    it('basic support', withContext(async (ctx) => {
      const callback = mock.fn()
      const throttled = ctx.throttle(callback, 1000)
      throttled()
      assert.strictEqual(callback.mock.calls.length, 1)
      await vi.advanceTimersByTimeAsync(600)
      throttled()
      assert.strictEqual(callback.mock.calls.length, 1)
      await vi.advanceTimersByTimeAsync(600)
      throttled()
      assert.strictEqual(callback.mock.calls.length, 2)
      await vi.advanceTimersByTimeAsync(2000)
      assert.strictEqual(callback.mock.calls.length, 3)
    }))

    it('trailing mode', withContext(async (ctx) => {
      const callback = mock.fn()
      const throttled = ctx.throttle(callback, 1000)
      throttled()
      assert.strictEqual(callback.mock.calls.length, 1)
      await vi.advanceTimersByTimeAsync(500)
      throttled()
      assert.strictEqual(callback.mock.calls.length, 1)
      await vi.advanceTimersByTimeAsync(500)
      assert.strictEqual(callback.mock.calls.length, 2)
      await vi.advanceTimersByTimeAsync(2000)
      assert.strictEqual(callback.mock.calls.length, 2)
    }))

    it('disposed', withContext(async (ctx) => {
      const callback = mock.fn()
      const throttled = ctx.throttle(callback, 1000)
      throttled.dispose()
      throttled()
      assert.strictEqual(callback.mock.calls.length, 1)
      await vi.advanceTimersByTimeAsync(500)
      throttled()
      await vi.advanceTimersByTimeAsync(2000)
      assert.strictEqual(callback.mock.calls.length, 1)
    }))
  })

  describe('ctx.debounce()', () => {
    it('basic support', withContext(async (ctx) => {
      const callback = mock.fn()
      const debounced = ctx.debounce(callback, 1000)
      debounced()
      assert.strictEqual(callback.mock.calls.length, 0)
      await vi.advanceTimersByTimeAsync(400)
      debounced()
      assert.strictEqual(callback.mock.calls.length, 0)
      await vi.advanceTimersByTimeAsync(400)
      debounced()
      assert.strictEqual(callback.mock.calls.length, 0)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(callback.mock.calls.length, 1)
    }))

    it('disposed', withContext(async (ctx) => {
      const callback = mock.fn()
      const debounced = ctx.debounce(callback, 1000)
      debounced.dispose()
      debounced()
      assert.strictEqual(callback.mock.calls.length, 0)
      await vi.advanceTimersByTimeAsync(2000)
      assert.strictEqual(callback.mock.calls.length, 0)
    }))
  })
})
