import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// This reads a dependency's source, so renaming or moving that constant fails
// this test. The alternative is a number whose justification nobody can check.
const RESOLVE = resolve('packages/loader/src/resolve.ts')

function constants() {
  const source = readFileSync(RESOLVE, 'utf8')
  const backoff = source.match(/const RENAME_BACKOFF = (\d+)/)
  const retries = source.match(/const RENAME_RETRIES = (\d+)/)
  if (!backoff || !retries) {
    throw new Error('the rename loop constants moved; re-derive `REREAD_DELAY` from the new ones')
  }
  return { backoff: Number(backoff[1]), retries: Number(retries[1]) }
}

function rereadDelay() {
  const source = readFileSync(resolve('packages/package-manager/src/retry.ts'), 'utf8')
  const match = source.match(/const REREAD_DELAY = (\d+)/)
  if (!match) throw new Error('`REREAD_DELAY` moved: update this file to find it again')
  return Number(match[1])
}

describe('the reread window', () => {
  it('is the longest interval the rename loop waits, so a lock it survived has lifted', () => {
    const { backoff, retries } = constants()
    // a control: both values are read, not asserted to themselves
    expect(backoff, 'the backoff step in `loader`').to.equal(20)
    expect(retries, 'the number of attempts in `loader`').to.equal(10)
    // the loop waits `backoff * (attempt + 1)` for `attempt < retries`; the last is `backoff * retries`
    expect(rereadDelay(), 'a shorter pause re-reads while the lock is still held')
      .toBeGreaterThanOrEqual(backoff * retries)
  })

  it('does not walk the tree again when the caller has already given up', async () => {
    const { reread } = await import('../src/retry.ts')
    const controller = new AbortController()
    let reads = 0
    const locked = () => {
      reads += 1
      const error: any = new Error('locked')
      error.code = 'EBUSY'
      return Promise.reject(error)
    }
    controller.abort()
    await expect(reread(locked, controller.signal)).rejects.toThrow()
    // one attempt, then the abort is observed instead of a second whole-tree read
    expect(reads, 'a second read costs the whole walk').to.equal(1)
  })
})
