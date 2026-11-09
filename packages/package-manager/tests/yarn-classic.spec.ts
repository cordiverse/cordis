import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readYarnClassicState } from '../src/readers/yarn-classic.ts'
import { diffState } from '../src/state.ts'
import { createProject } from './utils.ts'

describe('yarn classic', () => {
  function bundle(version: string) {
    const url = (name: string, version: string) => `https://registry.example/${name}/-/${name}-${version}.tgz#sha1`
    return {
      'node_modules/.yarn-integrity': {
        modulesFolders: ['node_modules'],
        // the lockfile has an entry for another copy of the bundled package
        lockfileEntries: { [`parent@${version}`]: url('parent', version), 'child@^1.0.0': url('child', '1.0.0') },
      },
      'node_modules/parent/package.json': { name: 'parent', version, bundleDependencies: ['child'] },
      'node_modules/parent/node_modules/child/package.json': { name: 'child', version: '1.0.0' },
      'node_modules/parent/node_modules/child/node_modules/grandchild/package.json': { name: 'grandchild', version: '1.0.0' },
    }
  }

  it('updates the packages bundled in an updated package', async () => {
    const before = await readYarnClassicState(createProject(bundle('1.0.0')))
    const after = await readYarnClassicState(createProject(bundle('2.0.0')))
    const diff = diffState('/', before, after)
    expect(diff.updated.map(change => change.name).sort()).to.deep.equal(['child', 'grandchild', 'parent'])
  })

  /** a project installed with the lockfile entries, each of which lists its patterns, and the packages by location */
  function classicProject(entries: [patterns: string[], version: string, url: string][], packages: Record<string, string>) {
    return {
      'yarn.lock': ['# yarn lockfile v1', '', ...entries.flatMap(([patterns, version, url]) => [
        // quoted as yarn does
        `${patterns.map(pattern => /^[a-z][^\s",:[\]\\]*$/i.test(pattern) ? pattern : JSON.stringify(pattern)).join(', ')}:`,
        `  version "${version}"`,
        `  resolved "${url}"`,
        '',
      ])].join('\n'),
      'node_modules/.yarn-integrity': {
        modulesFolders: ['node_modules'],
        lockfileEntries: Object.fromEntries(entries.flatMap(([patterns, , url]) => patterns.map(pattern => [pattern, url]))),
      },
      ...Object.fromEntries(Object.entries(packages).map(([location, version]) => {
        return [`${location}/package.json`, { name: location.split('/').pop(), version }]
      })),
    }
  }

  it('updates a package whose version has several sources', async () => {
    const dir = createProject(classicProject([
      [['alpha@^1.0.0'], '1.0.0', 'https://registry.example/alpha/-/alpha-1.0.0.tgz#sha1-a'],
      // the name of a tarball does not tell its version
      [['alpha@https://example.com/archive.tgz'], '1.0.0', 'https://example.com/archive.tgz#sha1-b'],
    ], { 'node_modules/alpha': '1.0.0', 'node_modules/beta': '1.0.0', 'node_modules/beta/node_modules/alpha': '1.0.0' }))
    const state = await readYarnClassicState(dir)
    expect(diffState(dir, state, state).updated.map(change => change.path).sort()).to.deep.equal([
      join(dir, 'node_modules/alpha'),
      join(dir, 'node_modules/beta/node_modules/alpha'),
    ])
  })

  it('identifies a version with a single source by that source', async () => {
    const dir = createProject(classicProject([
      // a quoted pattern may contain a comma
      [['alpha@https://example.com/alpha,one.tgz', 'alpha@~1.0.0'], '1.0.0', 'https://example.com/alpha,one.tgz#sha1-a'],
      [['alpha@^2.0.0'], '2.0.0', 'https://registry.example/alpha/-/alpha-2.0.0.tgz#sha1-b'],
    ], { 'node_modules/alpha': '2.0.0', 'node_modules/beta': '1.0.0', 'node_modules/beta/node_modules/alpha': '1.0.0' }))
    const state = await readYarnClassicState(dir)
    expect(state.size).to.equal(3)
    expect(diffState(dir, state, state).updated).to.deep.equal([])
  })
})
