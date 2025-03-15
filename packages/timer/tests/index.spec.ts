import { mock } from 'node:test'
import { FakeTimerInstallOpts, install, InstalledClock } from '@sinonjs/fake-timers'
import { Context } from 'cordis'
import assert from 'node:assert'
import Timer from '../src/index.js'

function withContext(callback: (ctx: Context, clock: InstalledClock) => Promise<void>, config?: FakeTimerInstallOpts) {
  return async () => {
    const ctx = new Context()
    const clock = install(config)
    await ctx.plugin(Timer)
    try {
      await ctx.plugin({ inject: ['timer'], apply: callback }, clock)
    } finally {
      clock.uninstall()
    }
  }
}

describe('ctx.setTimeout()', () => {
  it('basic support', withContext(async (ctx, clock) => {
    const callback = mock.fn()
    ctx.setTimeout(callback, 1000)
    assert.strictEqual(callback.mock.calls.length, 0)
    await clock.tickAsync(1000)
    assert.strictEqual(callback.mock.calls.length, 1)
    await clock.tickAsync(1000)
    assert.strictEqual(callback.mock.calls.length, 1)
  }))

  it('dispose', withContext(async (ctx, clock) => {
    const callback = mock.fn()
    const dispose = ctx.setTimeout(callback, 1000)
    assert.strictEqual(callback.mock.calls.length, 0)
    dispose()
    await clock.tickAsync(2000)
    assert.strictEqual(callback.mock.calls.length, 0)
  }))
})

describe('ctx.setInterval()', () => {
  it('basic support', withContext(async (ctx, clock) => {
    const callback = mock.fn()
    const dispose = ctx.setInterval(callback, 1000)
    assert.strictEqual(callback.mock.calls.length, 0)
    await clock.tickAsync(1000)
    assert.strictEqual(callback.mock.calls.length, 1)
    await clock.tickAsync(1000)
    assert.strictEqual(callback.mock.calls.length, 2)
    dispose()
    await clock.tickAsync(2000)
    assert.strictEqual(callback.mock.calls.length, 2)
  }))
})

describe('ctx.sleep()', () => {
  it('basic support', withContext(async (ctx, clock) => {
    const resolve = mock.fn()
    const reject = mock.fn()
    ctx.sleep(1000).then(resolve, reject)
    await clock.tickAsync(500)
    assert.strictEqual(resolve.mock.calls.length, 0)
    assert.strictEqual(reject.mock.calls.length, 0)
    await clock.tickAsync(500)
    assert.strictEqual(resolve.mock.calls.length, 1)
    assert.strictEqual(reject.mock.calls.length, 0)
    ctx.scope.dispose()
    await clock.tickAsync(2000)
    assert.strictEqual(resolve.mock.calls.length, 1)
    assert.strictEqual(reject.mock.calls.length, 0)
  }))
})

describe('ctx.throttle()', () => {
  it('basic support', withContext(async (ctx, clock) => {
    const callback = mock.fn()
    const throttled = ctx.throttle(callback, 1000)
    throttled()
    assert.strictEqual(callback.mock.calls.length, 1)
    await clock.tickAsync(600)
    throttled()
    assert.strictEqual(callback.mock.calls.length, 1)
    await clock.tickAsync(600)
    throttled()
    assert.strictEqual(callback.mock.calls.length, 2)
    await clock.tickAsync(2000)
    assert.strictEqual(callback.mock.calls.length, 3)
  }))

  it('trailing mode', withContext(async (ctx, clock) => {
    const callback = mock.fn()
    const throttled = ctx.throttle(callback, 1000)
    throttled()
    assert.strictEqual(callback.mock.calls.length, 1)
    await clock.tickAsync(500)
    throttled()
    assert.strictEqual(callback.mock.calls.length, 1)
    await clock.tickAsync(500)
    assert.strictEqual(callback.mock.calls.length, 2)
    await clock.tickAsync(2000)
    assert.strictEqual(callback.mock.calls.length, 2)
  }))

  it('disposed', withContext(async (ctx, clock) => {
    const callback = mock.fn()
    const throttled = ctx.throttle(callback, 1000)
    throttled.dispose()
    throttled()
    assert.strictEqual(callback.mock.calls.length, 1)
    await clock.tickAsync(500)
    throttled()
    await clock.tickAsync(2000)
    assert.strictEqual(callback.mock.calls.length, 1)
  }))
})

describe('ctx.debounce()', () => {
  it('basic support', withContext(async (ctx, clock) => {
    const callback = mock.fn()
    const debounced = ctx.debounce(callback, 1000)
    debounced()
    assert.strictEqual(callback.mock.calls.length, 0)
    await clock.tickAsync(400)
    debounced()
    assert.strictEqual(callback.mock.calls.length, 0)
    await clock.tickAsync(400)
    debounced()
    assert.strictEqual(callback.mock.calls.length, 0)
    await clock.tickAsync(1000)
    assert.strictEqual(callback.mock.calls.length, 1)
  }))

  it('disposed', withContext(async (ctx, clock) => {
    const callback = mock.fn()
    const debounced = ctx.debounce(callback, 1000)
    debounced.dispose()
    debounced()
    assert.strictEqual(callback.mock.calls.length, 0)
    await clock.tickAsync(2000)
    assert.strictEqual(callback.mock.calls.length, 0)
  }))
})
