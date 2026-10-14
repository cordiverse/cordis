import { describe, expect, it } from 'vitest'
import { fixture, harness, plugin } from './utils'

describe('Include path', () => {
  const { setup } = harness()

  // `path` arrives from a command line or from another plugin, so it can be an
  // absolute filesystem path. `new URL()` reads a Windows drive letter as a URL
  // scheme (`c:`), and `fileURLToPath` rejects anything that is not `file:`.
  // An absolute POSIX path is a legal URL path and already resolves as-is, so
  // this case only fails on Windows.
  it.runIf(process.platform === 'win32')('accepts a drive-letter path', async () => {
    const filename = fixture('path-abs.yml')
    const state = await setup('path-abs.yml', [plugin('inner', 1)], { path: filename })

    expect(state.include().filename).to.equal(filename)
    expect(state.config('inner')?.tag).to.equal('inner')
  }, 10000)
})
