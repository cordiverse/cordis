import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

// Node accepts `_` for `-` in every flag, so `--expose_internals` asks for the
// same thing as `--expose-internals`. Predicting the answer from `argv` can only
// match the spellings it knows, and `require` is what actually answers: a lookup
// that is already inside a `try` needs no prediction at all.
//
// A child process per arm, because the flag has to be on that process's own
// command line; the reachable spellings cannot be varied from inside one.
const source = pathToFileURL(fileURLToPath(new URL('../src/internal.ts', import.meta.url))).href

function reachable(...args: string[]): string {
  const output = execFileSync(process.execPath, [
    '--import', 'tsx', ...args, '--input-type=module', '-e',
    `const { getInternalLoader } = await import(${JSON.stringify(source)})
     console.log(typeof getInternalLoader()?.import === 'function' ? 'yes' : 'no')`,
  ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  return output.trim()
}

describe('getInternalLoader', () => {
  it('reaches the loader under either spelling of the flag', () => {
    expect(reachable('--expose-internals'), 'the hyphenated spelling').to.equal('yes')
    expect(reachable('--expose_internals'), 'the underscore spelling').to.equal('yes')
  })

  // Without this arm, a function that always answered `yes` would pass the case
  // above. `--no-warnings` is a flag that exposes nothing.
  it('reaches nothing when the flag is absent', () => {
    expect(reachable('--no-warnings')).to.equal('no')
  })
})
