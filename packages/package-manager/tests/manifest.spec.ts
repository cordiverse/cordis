import { describe, expect, it } from 'vitest'
import { applyChanges, normalizeChanges, stringifyManifest } from '../src/manifest.ts'

describe('manifest', () => {
  it('updates a dependency in the field that declares it', () => {
    const manifest = { dependencies: { a: '1' }, devDependencies: { b: '1' } }
    applyChanges(manifest, [['b', '2'], ['c', '1']])
    expect(manifest).to.deep.equal({ dependencies: { a: '1', c: '1' }, devDependencies: { b: '2' } })
  })

  it('removes a dependency from every field', () => {
    const manifest = { dependencies: { a: '1' }, optionalDependencies: { a: '1' }, peerDependencies: { a: '1' } }
    applyChanges(manifest, [['a', null]])
    expect(manifest).to.deep.equal({ dependencies: {}, optionalDependencies: {}, peerDependencies: { a: '1' } })
  })

  it('keeps a sorted field sorted', () => {
    const manifest = { dependencies: { b: '1', d: '1' } }
    applyChanges(manifest, [['c', '1'], ['a', '1']])
    expect(Object.keys(manifest.dependencies)).to.deep.equal(['a', 'b', 'c', 'd'])
  })

  it('keeps the indentation and line endings', () => {
    const original = '{\r\n    "name": "x"\r\n}\r\n'
    expect(stringifyManifest(JSON.parse(original), original)).to.equal(original)
  })

  it('rejects invalid input', () => {
    expect(() => normalizeChanges({ '../a': '1' })).to.throw(TypeError)
    expect(() => normalizeChanges({ a: '' })).to.throw(TypeError)
  })
})
