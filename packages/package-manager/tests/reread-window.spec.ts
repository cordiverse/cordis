import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// `REREAD_DELAY` is 200 ms because that is the longest interval the rename loop in `loader`
// ever waits before giving up: a second read costs a whole tree walk, so it is attempted once,
// after as long a pause as that loop would have taken. A behavioural test cannot pin the number
// -- a lock that lasts exactly 199 ms is not something a test can produce reliably -- so it is
// pinned here, against the constants the comment names: change either of them and this fails.
//
// Reading another package's source is a stronger assumption than a test should normally make.
// It is deliberate: the alternative is a magic 200 whose justification nobody can check.
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
})
