import { realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readNpmState } from '../src/readers/npm.ts'
import { diffState } from '../src/state.ts'
import { createProject } from './utils.ts'

describe('npm', () => {
  function bundle(integrity: string, version: string) {
    return {
      'node_modules/.package-lock.json': {
        packages: {
          'node_modules/parent': { version, resolved: `https://registry.example/parent-${version}.tgz`, integrity },
          'node_modules/parent/node_modules/child': { version: '1.0.0', inBundle: true },
          'node_modules/parent/node_modules/child/node_modules/grandchild': { version: '1.0.0', inBundle: true },
        },
      },
    }
  }

  it('updates the packages bundled in an updated package', async () => {
    const before = await readNpmState(createProject(bundle('sha512-a', '1.0.0')))
    const after = await readNpmState(createProject(bundle('sha512-b', '2.0.0')))
    const diff = diffState('/', before, after)
    expect(diff.updated.map(change => change.name).sort()).to.deep.equal(['child', 'grandchild', 'parent'])
  })

  it.skipIf(process.platform === 'win32')('reports the real directory below a linked node_modules', async () => {
    const dir = createProject({
      'shared/.package-lock.json': {
        packages: { 'node_modules/alpha': { version: '1.0.0', resolved: 'https://registry.example/alpha-1.0.0.tgz', integrity: 'sha512-a' } },
      },
      'shared/alpha/package.json': { name: 'alpha', version: '1.0.0' },
      'project/package.json': { name: 'project' },
    })
    symlinkSync('../shared', join(dir, 'project/node_modules'), 'dir')
    const state = await readNpmState(join(dir, 'project'))
    expect(state.get('node_modules/alpha')?.realpath).to.equal(realpathSync(join(dir, 'shared/alpha')))
  })
})
