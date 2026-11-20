import { describe, expect, it } from 'vitest'
import { diffState, InstallState, PackageState } from '../src/state.ts'
import { reread } from '../src/retry.ts'

describe('diffState', () => {
  it('updates a package whose real directory changed', () => {
    const state = (realpath: string): PackageState => ({ name: 'alpha', version: '1.0.0', resolution: 'sha512-a', local: false, realpath })
    const before: InstallState = new Map([['node_modules/alpha', state('/shared/alpha')]])
    const after: InstallState = new Map([['node_modules/alpha', state('/project/node_modules/alpha')]])
    expect(diffState('/project', before, after).updated.map(change => change.name)).to.deep.equal(['alpha'])
  })

  // An install whose result could not be read but whose lockfile did not change is the install
  // that was there before. Passing an empty state instead would report every package as removed,
  // which is the defect this guards against rather than a way to avoid it.
  it('treats an unchanged package set as no change, not as no packages', () => {
    const state = (): PackageState => ({ name: 'alpha', version: '1.0.0', resolution: 'sha512-a', local: false, realpath: '/project/node_modules/alpha' })
    const before: InstallState = new Map([['node_modules/alpha', state()]])
    expect(diffState('/project', before, before)).to.deep.equal({ added: [], removed: [], updated: [] })
    expect(diffState('/project', before, new Map()).removed.map(change => change.name),
      'an empty state is every package removed').to.deep.equal(['alpha'])
  })

  // The reason a lockfile cannot answer for a local package: its content is not identified by
  // the state, so an install that leaves the lockfile alone still reports it as updated. Callers
  // rely on that to copy the content of a `file:` or `link:` dependency again.
  // The retry in `_install` is the whole answer to a read that failed, so it is driven directly
  // rather than described. The table is the specification of the code set: every code the reader
  // can raise is a row, so dropping one from `isTransient` fails a case instead of passing
  // silently. `loader/tests/resolve.spec.ts` uses the same shape for the rename retry.
  it.each([
    { code: 'EBUSY', attempts: 2, retried: true },
    { code: 'EPERM', attempts: 2, retried: true },
    { code: 'EACCES', attempts: 2, retried: true },
    { code: 'ENOENT', attempts: 1, retried: false },
    { code: 'ENOTDIR', attempts: 1, retried: false },
    { code: 'EIO', attempts: 1, retried: false },
    { code: 'ENOSPC', attempts: 1, retried: false },
  ])('makes $attempts attempt(s) when the read fails with $code', async ({ code, attempts, retried }) => {
    const state: InstallState = new Map()
    let calls = 0
    const read = async () => {
      if (++calls === 1) throw Object.assign(new Error(code), { code })
      return state
    }
    if (retried) {
      expect(await reread(read), 'the second attempt is used').to.equal(state)
    } else {
      await expect(reread(read), code).rejects.toThrow(code)
    }
    expect(calls).to.equal(attempts)
  })

  // A wall that does not lift is reported, not retried forever: the loop is bounded by design.
  it('gives up when the wall stays', async () => {
    let attempts = 0
    const wall = async () => {
      attempts++
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    }
    await expect(reread(wall)).rejects.toThrow('busy')
    expect(attempts, 'exactly two attempts, not a loop').to.equal(2)
  })

  // The class that must not be forgotten: nothing went wrong, so nothing may be retried or waited
  // for. The cases above cannot see a `reread` that always waited -- they throw on the first read,
  // before any delay would be noticed -- so without this one, waiting on the success path would go
  // unmeasured.
  it('reads once and waits not at all when the first read works', async () => {
    const state: InstallState = new Map()
    let attempts = 0
    const started = Date.now()
    expect(await reread(async () => (attempts++, state))).to.equal(state)
    expect(attempts, 'the ordinary path reads once').to.equal(1)
    expect(Date.now() - started, 'and does not wait').toBeLessThan(40)
  })

  // An error without a `code` is not an errno at all -- a bug in the reader, or a rejected
  // promise from something else. Retrying it would turn one failure into two.
  it('does not retry an error that carries no errno code', async () => {
    let attempts = 0
    const plain = async () => {
      attempts++
      throw new Error('not an errno')
    }
    await expect(reread(plain)).rejects.toThrow('not an errno')
    expect(attempts, 'no code means no retry').to.equal(1)
  })

  it('reports a local package as updated even when its resolution is unchanged', () => {
    const local = (): PackageState => ({ name: 'alpha', version: '1.0.0', resolution: '1.0.0 file:./local', local: true, realpath: '/project/node_modules/alpha' })
    const before: InstallState = new Map([['node_modules/alpha', local()]])
    const after: InstallState = new Map([['node_modules/alpha', local()]])
    expect(diffState('/project', before, after).updated.map(change => change.name)).to.deep.equal(['alpha'])
  })
})
