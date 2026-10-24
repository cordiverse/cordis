import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))

// A flipped `type` is decided at load time, and the load hook that answers for
// it is not called under the test runner (measured: the hook sees zero
// lookups there), so the case runs in a plain node process — the shape the
// code actually runs in.
describe('manifest type flip', () => {
  it('loads a flipped module under its new format', () => {
    const script = resolve(testDir, '__probe__', 'flip-type.ts')
    const output = execFileSync(process.execPath, ['--experimental-strip-types', script], { encoding: 'utf8' })
    expect(output).to.contain('FLIP first=CJS second=ESM')
  }, 60000)
})
