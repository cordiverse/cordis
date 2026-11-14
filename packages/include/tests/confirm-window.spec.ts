import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// `CONFIRM` is 60 ms because chokidar's throttle for `change` is 50 ms: a confirm shorter than
// the window re-reads before the suppressed write lands, which is the defect the confirm exists
// to cover. A behavioural test cannot pin that number without racing the operating system --
// measured, a wall-clock 45 ms gap caught a 25 ms confirm once in six runs, and anchoring the
// second write to a second watcher's event still ran 1 in 3. So the number is pinned here, against
// the dependency itself: read the window chokidar uses, and fail when it moves.
//
// This reads a dependency's source, which is a stronger assumption than a test should normally
// make. It is deliberate: the alternative is a magic 60 whose justification nobody can check.
const CHOKIDAR = resolve('node_modules/chokidar/index.js')

function confirm(): number {
  const source = readFileSync(resolve('packages/include/src/index.ts'), 'utf8')
  const match = source.match(/const CONFIRM = (\d+)/)
  if (!match) throw new Error('CONFIRM moved: update this file to find it again')
  return Number(match[1])
}

function throttleWindow(): number {
  const source = readFileSync(CHOKIDAR, 'utf8')
  const match = source.match(/_throttle\((?:handler_js_1\.)?EVENTS\.CHANGE,\s*path,\s*(\d+)\)/)
  if (!match) {
    throw new Error('the throttle call site for `change` moved; re-derive CONFIRM from the new one')
  }
  return Number(match[1])
}

describe('the confirm window', () => {
  it('is at least the window chokidar suppresses `change` in', () => {
    const window = throttleWindow()
    // a control: the value is read, not asserted to itself
    expect(window, 'chokidar 4.x suppresses `change` for 50 ms').to.equal(50)
    expect(confirm(), 'a shorter confirm re-reads before the suppressed write lands')
      .toBeGreaterThanOrEqual(window)
  })
})
