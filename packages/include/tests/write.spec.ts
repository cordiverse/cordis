import { expect, describe, it, beforeAll, afterAll, afterEach } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import * as yaml from 'js-yaml'
import { harness, plugin } from './utils'

/**
 * Failure injection for `rename`. Every scheduled failure rejects with the
 * given code; `beforeFail` runs right before the rejection so a test can
 * simulate an external writer racing the include.
 */
const renames = {
  calls: 0,
  failures: 0,
  code: 'EBUSY',
  beforeFail: undefined as (() => Promise<void>) | undefined,
}

// The loader imports the include through Node's own module loader (the tests
// run with --expose-internals), outside vitest's module graph. Patching the
// CJS side of the builtin and syncing the ESM bindings reaches every copy.
const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
const actualRename = fsp.rename

describe('Include write', () => {
  const { setup } = harness()

  beforeAll(() => {
    fsp.rename = async (from, to) => {
      renames.calls++
      if (renames.failures > 0) {
        renames.failures--
        await renames.beforeFail?.()
        throw Object.assign(new Error(`${renames.code}: resource busy`), { code: renames.code })
      }
      return actualRename(from, to)
    }
    syncBuiltinESMExports()
  })

  afterAll(() => {
    fsp.rename = actualRename
    syncBuiltinESMExports()
  })

  afterEach(() => {
    Object.assign(renames, { calls: 0, failures: 0, code: 'EBUSY', beforeFail: undefined })
  })

  it('retries a rename that fails transiently', async () => {
    const app = await setup('tmp-write-retry.yml', [plugin('a', 1)])
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
    const app = await setup('tmp-write-race.yml', [plugin('a', 1), plugin('b', 1)])
    renames.calls = 0
    renames.failures = 1
    renames.beforeFail = () => writeFile(app.filename, yaml.dump([plugin('a', 1), plugin('b', 2)]))

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
    const app = await setup('tmp-write-fatal.yml', [plugin('a', 1)])
    const text = await app.text()
    renames.calls = 0
    renames.failures = 1
    renames.code = 'ENOSPC'

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
    const app = await setup('tmp-write-bounded.yml', [plugin('a', 1)])
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
