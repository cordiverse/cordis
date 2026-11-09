import { describe, expect, it } from 'vitest'
import { diffState, InstallState, PackageState } from '../src/state.ts'

describe('diffState', () => {
  it('updates a package whose real directory changed', () => {
    const state = (realpath: string): PackageState => ({ name: 'alpha', version: '1.0.0', resolution: 'sha512-a', local: false, realpath })
    const before: InstallState = new Map([['node_modules/alpha', state('/shared/alpha')]])
    const after: InstallState = new Map([['node_modules/alpha', state('/project/node_modules/alpha')]])
    expect(diffState('/project', before, after).updated.map(change => change.name)).to.deep.equal(['alpha'])
  })
})
