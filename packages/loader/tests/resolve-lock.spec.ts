import { expect, describe, it, afterEach } from 'vitest'
import { closeSync, openSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createResolve } from '../src/resolve'

const roots: string[] = []

/**
 * A project that owns a bare dependency, plus a second nested project below it
 * so one scope's helper can be prepared before another scope is ever asked for
 * one. Node walks up from the nested scope, so both reach the same dependency.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cordis-resolve-lock-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fixture-app',
    type: 'module',
  }))
  const dep = join(root, 'node_modules', 'fixture-dep')
  await mkdir(dep, { recursive: true })
  await writeFile(join(dep, 'package.json'), JSON.stringify({
    name: 'fixture-dep',
    type: 'module',
    exports: { '.': { import: './index.js' } },
  }))
  await writeFile(join(dep, 'index.js'), 'export const tag = "bare-dep"\n')
  await mkdir(join(root, 'nested', 'src'), { recursive: true })
  await writeFile(join(root, 'nested', 'package.json'), JSON.stringify({
    name: 'nested-app',
    type: 'module',
  }))
  return {
    root,
    outer: pathToFileURL(join(root, 'src', 'cordis.yml')).href,
    nested: pathToFileURL(join(root, 'nested', 'src', 'cordis.yml')).href,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('helper preparation', () => {
  it('retries a scope that could not be prepared on an earlier call', async () => {
    const { root, outer } = await fixture()
    // A file where the helper directory belongs makes the preparation fail.
    await writeFile(join(root, '.cordis'), 'blocker')
    expect(await createResolve(outer)).to.be.undefined

    await rm(join(root, '.cordis'))
    const resolver = await createResolve(outer)
    expect(resolver).to.be.ok
    expect((await import(resolver!('fixture-dep'))).tag).to.equal('bare-dep')
  })

  it('leaves no temp file behind when the rename cannot succeed', async () => {
    const { root, outer } = await fixture()
    // A directory where the helper belongs is never replaced by a rename.
    await mkdir(join(root, '.cordis', 'resolve.mjs'), { recursive: true })
    expect(await createResolve(outer)).to.be.undefined
    const left = (await readdir(join(root, '.cordis'))).filter(name => name.startsWith('resolve.mjs.'))
    expect(left).to.deep.equal([])
  })
})

// Windows refuses to rename over a file that any process holds open, so the
// two cases below only differ from a plain write there.
describe.runIf(process.platform === 'win32')('a helper held open by another process', () => {
  it('reuses the helper that is already in place', async () => {
    const { root, outer, nested } = await fixture()
    await createResolve(outer)
    await cp(join(root, '.cordis'), join(root, 'nested', '.cordis'), { recursive: true })

    const fd = openSync(join(root, 'nested', '.cordis', 'resolve.mjs'), 'r')
    try {
      const resolver = await createResolve(nested)
      expect(resolver).to.be.ok
      expect(resolver!('fixture-dep')).to.include('index.js')
    } finally {
      closeSync(fd)
    }
  })

  it('rewrites a stale helper once the lock is released', async () => {
    const { root, outer, nested } = await fixture()
    await createResolve(outer)
    await cp(join(root, '.cordis'), join(root, 'nested', '.cordis'), { recursive: true })
    await writeFile(join(root, 'nested', '.cordis', 'resolve.mjs'), 'export default () => "stale"\n')

    const fd = openSync(join(root, 'nested', '.cordis', 'resolve.mjs'), 'r')
    let released = false
    const timer = setTimeout(() => {
      released = true
      closeSync(fd)
    }, 300)
    try {
      const resolver = await createResolve(nested)
      expect(resolver).to.be.ok
      expect(resolver!('fixture-dep')).to.include('index.js')
    } finally {
      clearTimeout(timer)
      if (!released) closeSync(fd)
    }
  })
})
