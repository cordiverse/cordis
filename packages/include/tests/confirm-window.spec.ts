import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// This reads a dependency's source, so renaming or moving that constant fails
// this test. The alternative is a number whose justification nobody can check.
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
