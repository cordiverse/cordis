import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readYarnClassicState } from '../src/readers/yarn-classic.ts'
import { diffState } from '../src/state.ts'
import { createProject } from './utils.ts'

// `chmod` cannot produce `EACCES` portably, so the listing is failed instead: same folder
// name, only while the flag is set.
const failing = vi.hoisted(() => ({ readdir: false, folder: 'node_modules' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: async (path: any, options: any) => {
      if (failing.readdir && String(path).split(/[\\/]/).pop() === failing.folder) {
        throw Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' })
      }
      return actual.readdir(path, options)
    },
  }
})

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

  // A project with a readme but no install state: what `readText` would call "does not exist".
  function emptyProject(folder: string, extra: Record<string, unknown> = {}) {
    return createProject({
      'node_modules/.yarn-integrity': { modulesFolders: [folder], lockfileEntries: {} },
      ...extra,
    })
  }

  it('treats a folder that is not there as nothing installed', async () => {
    const state = await readYarnClassicState(emptyProject('absent'))
    expect(state.size, 'nothing is installed, and that is an answer').to.equal(0)
  })

  it('treats a path below a file as nothing installed', async () => {
    const state = await readYarnClassicState(emptyProject('a-file', { 'a-file': 'not a directory' }))
    expect(state.size).to.equal(0)
  })

  // A folder that can be traversed but not listed (POSIX `--x`; a locked directory on Windows).
  // It reads as empty before this change, so `diffState` reports everything under it removed.
  it('does not read an unreadable folder as nothing installed', async () => {
    const dir = createProject(bundle('1.0.0'))
    const before = await readYarnClassicState(dir)
    expect(before.size, 'the device can read a project it is allowed to read').to.be.greaterThan(0)

    failing.readdir = true
    try {
      await expect(readYarnClassicState(dir)).rejects.toThrow(/EACCES/)
    } finally {
      failing.readdir = false
    }
  })

  // A zero-byte manifest is a package that is there and broken. Skipping it reads like "not a
  // package", and `diffState` then reports it removed -- measured: the state drops the package.
  it('does not read an empty manifest as a folder that is not a package', async () => {
    const dir = createProject({
      'node_modules/.yarn-integrity': { modulesFolders: ['node_modules'], lockfileEntries: {} },
      'node_modules/alpha/package.json': { name: 'alpha', version: '1.0.0' },
    })
    expect((await readYarnClassicState(dir)).size, 'the device can read it while it is valid').to.equal(1)

    writeFileSync(join(dir, 'node_modules/alpha/package.json'), '')
    await expect(readYarnClassicState(dir)).rejects.toThrow()
  })

  // The scope folder is the second `readdir`. Fixing only the first leaves this one answering
  // "empty", which drops every package under the scope.
  it('does not read an unreadable scope folder as nothing installed', async () => {
    const dir = createProject({
      'node_modules/.yarn-integrity': { modulesFolders: ['node_modules'], lockfileEntries: {} },
      'node_modules/@scope/alpha/package.json': { name: '@scope/alpha', version: '1.0.0' },
    })
    const readable = await readYarnClassicState(dir)
    expect(readable.size, 'the device can read a project it is allowed to read').to.equal(1)

    failing.readdir = true
    failing.folder = '@scope'
    try {
      await expect(readYarnClassicState(dir)).rejects.toThrow(/EACCES/)
    } finally {
      failing.readdir = false
      failing.folder = 'node_modules'
    }
  })
})
