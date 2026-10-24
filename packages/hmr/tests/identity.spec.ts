import { mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IdentityStore } from '../src/identity.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(testDir, '__identity__')

function fixture(name: string, content: string) {
  const path = resolve(fixtureDir, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return pathToFileURL(path).href
}

describe('IdentityStore', () => {
  beforeAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
    mkdirSync(fixtureDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  it('detects every same-size rewrite in a rapid loop', () => {
    const store = new IdentityStore()
    const url = fixture('rapid.js', 'a'.repeat(64))
    store.observe(url)
    const path = fileURLToPath(url)
    let detected = 0
    for (let i = 0; i < 300; i++) {
      // same length, different content: `size` cannot see this, and a write
      // this close to the previous one may not advance `mtime` either
      writeFileSync(path, `v${i}`.padStart(64, '0'))
      if (store.changed(url)) detected++
      store.observe(url)
    }
    // the timestamps catch what they can; the content hash catches the rest
    expect(detected).to.equal(300)
  }, 30000)

  it('detects a file replaced by an atomic save', () => {
    const store = new IdentityStore()
    const url = fixture('atomic.js', 'a'.repeat(12))
    const path = fileURLToPath(url)
    // pin the mtime so that only the inode can identify the replacement
    const t = Date.now() / 1000
    utimesSync(path, t, t)
    store.observe(url)

    // an editor-style save: a temporary file renamed over the original, which
    // gives the file a new inode
    writeFileSync(`${path}.tmp`, 'b'.repeat(12))
    utimesSync(`${path}.tmp`, t, t)
    renameSync(`${path}.tmp`, path)

    expect(store.changed(url)).to.equal(true)
  })

  it('treats a deleted file as changed', () => {
    const store = new IdentityStore()
    const url = fixture('gone.js', 'content')
    store.observe(url)
    rmSync(fileURLToPath(url))
    expect(store.changed(url)).to.equal(true)
  })

  it('treats a file without a record as changed', () => {
    const store = new IdentityStore()
    const url = fixture('fresh.js', 'content')
    // never observed: the content cannot be proven unchanged
    expect(store.changed(url)).to.equal(true)
  })

  it('leaves an unchanged file alone', () => {
    const store = new IdentityStore()
    const url = fixture('stable.js', 'content')
    store.observe(url)
    expect(store.changed(url)).to.equal(false)
  })

  it('only suspects a rewrite while the write is younger than the window', async () => {
    const url = fixture('window.js', 'aaaa')
    const path = fileURLToPath(url)
    // pin the mtime so that the observations below see a write of known age
    const t = Date.now() / 1000
    utimesSync(path, t, t)
    await new Promise(resolve => setTimeout(resolve, 5))

    const strict = new IdentityStore(0)
    strict.observe(url)
    const lax = new IdentityStore(5000)
    lax.observe(url)

    // rewrite with the same size and pin the mtime back: the recorded fields
    // are now identical, and only the content hash can tell them apart
    writeFileSync(path, 'bbbb')
    utimesSync(path, t, t)

    expect(strict.changed(url)).to.equal(false)
    expect(lax.changed(url)).to.equal(true)
  })

  it('expands a root to the files under it that cannot be proven unchanged', () => {
    const store = new IdentityStore()
    const changed = fixture('pkg/changed.js', 'a'.repeat(32))
    store.observe(changed)
    writeFileSync(fileURLToPath(changed), 'b'.repeat(32))
    // loaded, but loaded after the last observation
    const fresh = fixture('pkg/fresh.js', 'content')
    // recorded and untouched
    const stable = fixture('pkg/stable.js', 'content')
    store.observe(stable)
    // changed, but outside the root
    const elsewhere = fixture('other/changed.js', 'x'.repeat(32))
    store.observe(elsewhere)
    writeFileSync(fileURLToPath(elsewhere), 'y'.repeat(32))
    // neither recorded nor loaded: a file a package operation just added is
    // not part of the batch
    fixture('pkg/idle.js', 'content')

    const root = pathToFileURL(resolve(fixtureDir, 'pkg')).href
    expect(store.expand(root, [fresh]).sort())
      .to.deep.equal([changed, fresh].sort())
    // a root may be a single file as well
    expect(store.expand(changed, [])).to.deep.equal([changed])
  })

  it('forgets a record', () => {
    const store = new IdentityStore()
    const url = fixture('forgotten.js', 'content')
    store.observe(url)
    store.forget(fileURLToPath(url))
    // without the record the content cannot be proven unchanged
    expect(store.changed(url)).to.equal(true)
  })
})
