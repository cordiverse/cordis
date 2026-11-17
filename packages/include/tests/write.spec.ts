import { expect, describe, it, afterEach } from 'vitest'
import { FsError } from '@cordisjs/fs'
import MemoryFs from '@cordisjs/fs-memory'
import * as yaml from 'yaml'
import { harness, component } from './utils.ts'

/**
 * Failure injection for `rename`. Every scheduled failure rejects with the
 * given code; `beforeFail` runs right before the rejection so a test can
 * simulate an external writer racing the include.
 */
const renames = {
  calls: 0,
  failures: 0,
  code: 'Busy' as FsError.Code,
  beforeFail: undefined as (() => Promise<void>) | undefined,
}

class FlakyFs extends MemoryFs {
  async rename(src: URL, dest: URL) {
    renames.calls++
    if (renames.failures > 0) {
      renames.failures--
      await renames.beforeFail?.()
      throw new FsError(renames.code, src, `cannot rename ${src.href} to ${dest.href}`)
    }
    return super.rename(src, dest)
  }
}

describe('Include write', () => {
  const { setup } = harness({ Provider: FlakyFs })

  afterEach(() => {
    Object.assign(renames, { calls: 0, failures: 0, code: 'Busy', beforeFail: undefined })
  })

  it('retries a rename that fails transiently', async () => {
    const app = await setup('tmp-write-retry.yml', [component('a', 1)])
    renames.calls = 0
    renames.failures = 2

    await app.update('a', { config: { tag: 'a', value: 2 } })
    await app.settle()

    expect(renames.calls).toBe(3)
    expect((await app.read())[0].config.value).toBe(2)
    expect(app.logs('warn')).toEqual([])
    expect(app.logs('error')).toEqual([])
  }, 10000)

  it('never overwrites a change that lands while it waits to retry', async () => {
    const app = await setup('tmp-write-race.yml', [component('a', 1), component('b', 1)])
    renames.calls = 0
    renames.failures = 1
    renames.beforeFail = () => app.write(yaml.stringify([component('a', 1), component('b', 2)]))

    await app.update('a', { config: { tag: 'a', value: 2 } })
    await app.settle()

    // the stale check before the retry sees the external edit, and the
    // runtime change is merged into it
    const [a, b] = await app.read()
    expect(a.config.value).toBe(2)
    expect(b.config.value).toBe(2)
    expect(app.config('b').value).toBe(2)
    expect(renames.calls).toBe(2)
    expect(app.logs('error')).toEqual([])
  }, 10000)

  it('does not retry other errors, but still flushes on dispose', async () => {
    const app = await setup('tmp-write-fatal.yml', [component('a', 1)])
    const text = await app.text()
    renames.calls = 0
    renames.failures = 1
    renames.code = 'PermissionDenied'

    await app.update('a', { config: { tag: 'a', value: 2 } })
    await app.settle()

    expect(renames.calls).toBe(1)
    expect(await app.text()).toBe(text)
    expect(app.logs('warn').some(line => line.includes('failed to write'))).toBe(true)
    expect(app.config('a').value).toBe(2)

    await app.dispose()
    expect((await app.read())[0].config.value).toBe(2)
  }, 10000)

  it('gives up after a bounded number of attempts and keeps the change', async () => {
    const app = await setup('tmp-write-bounded.yml', [component('a', 1)])
    const text = await app.text()
    renames.calls = 0
    renames.failures = Infinity

    await app.update('a', { config: { tag: 'a', value: 2 } })
    await app.settle()

    expect(renames.calls).toBe(11)
    expect(await app.text()).toBe(text)
    expect(app.logs('warn').some(line => line.includes('failed to write'))).toBe(true)
    expect(app.config('a').value).toBe(2)

    // the lock clears; the journal goes out with the dispose flush
    renames.failures = 0
    await app.dispose()
    expect((await app.read())[0].config.value).toBe(2)
  }, 10000)
})
