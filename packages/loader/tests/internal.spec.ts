import { expect, describe, it } from 'vitest'
import { ModuleLoader } from '../src'

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
