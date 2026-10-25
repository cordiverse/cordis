import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = resolve(dirname(fileURLToPath(import.meta.url)), '__probe__/loadcache.mjs')

describe('loadCache shape', () => {
  it('matches what the eviction comment says', () => {
    // the child needs the flag for `internal/modules/esm/loader`; the CI
    // matrix (24 and 26) accepts it
    const output = execFileSync(process.execPath, ['--expose-internals', script], {
      encoding: 'utf8',
      timeout: 60000,
    })
    const line = output.split('\n').find(item => item.trim().startsWith('{'))
    if (!line) throw new Error(`no loadCache result: ${output.slice(-600)}`)
    const result = JSON.parse(line)

    // `loadCache` carries the Map internal slots while `instanceof Map` is false
    expect(result.instanceofMap).to.equal(false)
    expect(result.mapGetWorks).to.equal(true)
    // a JSON module lives in the `json` slot, which `has(url)` does not see
    expect(result.jsonSlots).to.include('json')
    expect(result.hasJson).to.equal(false)
    // its own `delete(url)` clears the slot and leaves the key in the map
    expect(result.afterDeletePresent).to.equal(true)
    expect(result.afterDeleteJavascript).to.equal(true)
    // a CJS module imported through `import()` is in both caches
    expect(result.cjsInLoadCache).to.equal(true)
    expect(result.cjsInRequireCache).to.equal(true)
  }, 60000)
})
