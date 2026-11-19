import { describe, expect, it } from 'vitest'
import { createFilter } from '../src/index.ts'

// the paths of `entries` that the filter keeps, each a file unless it ends with `/`
function kept(filter: string[], entries: string[]) {
  const keep = createFilter(filter)
  return entries.filter((entry) => {
    const isDirectory = entry.endsWith('/')
    return keep(isDirectory ? entry.slice(0, -1) : entry, isDirectory)
  })
}

describe('createFilter', () => {
  it('returns a predicate as it is', () => {
    const predicate = (path: string) => path === 'a'
    expect(createFilter(predicate)).to.equal(predicate)
  })

  it('selects the entries by glob patterns relative to the watched directory', () => {
    const filter = ['lib', 'src/**/*.ts', 'packages/*', '!**/.*', '!src/log[!0-9].ts']
    expect(kept(filter, [
      'lib/file.txt',
      'src/index.ts',
      'src/deep/index.ts',
      'src/log1.ts',
      'packages/a/deep/file.js',
      'lib/.hidden.txt',
      'src/index.js',
      'src/logx.ts',
      'other.txt',
    ])).to.deep.equal([
      'lib/file.txt',
      'src/index.ts',
      'src/deep/index.ts',
      'src/log1.ts',
      'packages/a/deep/file.js',
    ])
  })

  it('keeps a directory that an including pattern may lead below', () => {
    const filter = ['src/**/*.ts', 'packages/*/lib']
    expect(kept(filter, ['src/', 'src/deep/', 'packages/', 'packages/a/', 'other/'])).to.deep.equal([
      'src/',
      'src/deep/',
      'packages/',
      'packages/a/',
    ])
  })

  it('decides an entry by the last pattern that matches it or one of its ancestors', () => {
    const filter = ['src', '!src/gen', 'src/gen/keep.ts']
    expect(kept(filter, ['src/index.ts', 'src/gen/keep.ts', 'src/gen/other.ts', 'src/gen/'])).to.deep.equal([
      'src/index.ts',
      'src/gen/keep.ts',
      'src/gen/',
    ])
  })

  it('matches a name that a pattern escapes', () => {
    expect(kept(['pkg\\[one\\]/*.ts'], ['pkg[one]/', 'pkg[one]/file.ts', 'pkgo/file.ts'])).to.deep.equal([
      'pkg[one]/',
      'pkg[one]/file.ts',
    ])
  })

  it('normalizes the patterns', () => {
    expect(kept(['./src//a/../*.ts'], ['src/b.ts', 'src/a/b.ts'])).to.deep.equal(['src/b.ts'])
  })

  it('keeps every entry with `.`', () => {
    expect(kept(['.', '!**/.*'], ['a.txt', 'dir/', 'dir/b.txt', '.hidden'])).to.deep.equal(['a.txt', 'dir/', 'dir/b.txt'])
  })

  it('keeps no entry without patterns', () => {
    expect(kept([], ['a.txt', 'dir/'])).to.deep.equal([])
  })

  it('rejects an entry leading outside the watched directory', () => {
    for (const entry of ['../outside', '!../outside', 'a/../../outside', '/absolute']) {
      expect(() => createFilter([entry])).to.throw(TypeError)
    }
  })
})
