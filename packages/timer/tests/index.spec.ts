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
