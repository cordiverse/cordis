import { expect, describe, it } from 'vitest'
import { ModuleLoader } from '../src/runtime/index.ts'
import { internalsUnavailable } from '../src/index.ts'

// The message is built in one place so it can be asserted here: the throw itself is
// only reachable in a process that cannot reach the internals, which is the one
// environment a test cannot ask for.
describe('internalsUnavailable', () => {
  it('keeps the instruction when there is no reason', () => {
    expect(internalsUnavailable()).to.equal(
      'loader internals are unavailable, pass --expose-internals or install node-addon-require-builtin')
  })

  it('appends the reason the loader recorded', () => {
    // a user who already installed the addon is the one this line is for
    const message = internalsUnavailable('node-addon-require-builtin: Cannot find module')
    expect(message).to.include('pass --expose-internals')
    expect(message).to.include('node-addon-require-builtin: Cannot find module')
  })
})

describe('ModuleLoader.fromInternal', () => {
  it('tags the running loader with the resolver signature it accepts', () => {
    const loader = ModuleLoader.fromInternal()
    expect(loader, 'node module internals are unreachable; hmr partial reload needs them').to.be.ok
    // Resolving through the tag is exactly what `Hmr._resolve()` does. A tag
    // taken from the node major instead of the loader's own API rejects every
    // call on 24.0-24.11.1, which report major 24 while carrying the v1 loader.
    const resolved = loader!.version === 'v2'
      ? loader!.resolveSync(import.meta.url, { specifier: 'node:path', attributes: {} })
      : loader!.resolveSync('node:path', import.meta.url, {})
    expect(resolved.url).to.equal('node:path')
  })
})
