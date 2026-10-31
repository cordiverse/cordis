import { mkdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
  // A store whose stat can be made to fail: the only other way to make a stat
  // fail after the same path resolved is a race between the two calls.
  class Unstatable extends IdentityStore {
    failing = false
    protected override stat(path: string) {
      if (this.failing) return undefined
      return super.stat(path)
    }
  }

  it('treats a file it cannot stat as changed', () => {
    const store = new Unstatable()
    const url = fixture('unstatable.js', 'content')
    store.observe(url)
    store.failing = true
    // nothing proves it unchanged, and the comparison must not throw
    expect(store.changed(url)).to.equal(true)
  })

  it('records nothing for a file it cannot stat', () => {
    const store = new Unstatable()
    const url = fixture('unstatable-gone.js', 'content')
    store.observe(url)
    store.failing = true
    expect(store.observe(url)).to.be.undefined
    store.failing = false
    expect(store.expand(pathToFileURL(fixtureDir).href, [])).to.deep.equal([])
  })

  it('answers no stat for a path that cannot be read', () => {
    class Exposed extends IdentityStore {
      read(path: string) { return super.stat(path) }
    }
    // the ordinary way a stat fails, without any race
    expect(new Exposed().read(resolve(fixtureDir, 'not-there.js'))).to.be.undefined
  })

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

  it('forgets a deleted file once it has been reported', () => {
    const store = new IdentityStore()
    const url = fixture('deleted.js', 'content')
    store.observe(url)
    const root = pathToFileURL(fixtureDir).href

    rmSync(fileURLToPath(url))
    // a file that no longer resolves cannot be proven unchanged, so it is
    // reported once...
    expect(store.expand(root, [])).to.deep.equal([url])
    // ...and the record goes with it: leaving it behind would report the same
    // ghost on every later call, forever
    expect(store.expand(root, [])).to.deep.equal([])
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

  it('does not trust a stamp the clock has not reached', () => {
    const store = new IdentityStore()
    const url = fixture('future.js', 'aaaa')
    const path = fileURLToPath(url)
    // an archive or a skewed mount can hand a file a time this process has not
    // reached; nothing then separates a later write from this one
    const t = Date.now() / 1000 + 60
    utimesSync(path, t, t)
    store.observe(url)

    // same size, and the writer restores the stamp it found
    writeFileSync(path, 'bbbb')
    utimesSync(path, t, t)

    expect(store.changed(url)).to.equal(true)
  })

  it('reports a change for a file it cannot read', () => {
    const store = new IdentityStore()
    // a directory stats like a file and reads with EISDIR; a file another
    // process holds answers the same way, which a read must not turn into a
    // failed reconcile
    const dir = resolve(fixtureDir, 'unreadable')
    mkdirSync(dir, { recursive: true })
    const url = pathToFileURL(dir).href
    expect(() => store.observe(url)).to.not.throw()
    expect(store.changed(url)).to.equal(true)
  })

  it('still matches the files under a root that has been removed', () => {
    const store = new IdentityStore()
    const url = fixture('removed-root/index.js', 'content')
    store.observe(url)
    const root = pathToFileURL(resolve(fixtureDir, 'removed-root')).href
    rmSync(resolve(fixtureDir, 'removed-root'), { recursive: true, force: true })
    // a package that was uninstalled cannot be realpath'd any more, and the
    // modules it left behind are what the caller has to hear about
    expect(store.expand(root, [])).to.deep.equal([url])
  })

  it('matches a removed root that is spelled with a trailing separator', () => {
    const store = new IdentityStore()
    const dir = resolve(fixtureDir, 'trimmed-root')
    mkdirSync(dir, { recursive: true })
    const file = resolve(dir, 'index.js')
    writeFileSync(file, 'content')
    const url = pathToFileURL(file).href
    store.observe(url)
    rmSync(dir, { recursive: true, force: true })
    // a removed root cannot be realpath'd, so the spelling is used as given,
    // and one that ends with a separator would match nothing if the comparison
    // appended another
    expect(store.expand(pathToFileURL(dir).href + '/', [])).to.deep.equal([url])
  })

  it('drops the record of a file that is gone when it is observed again', () => {
    const store = new IdentityStore()
    const url = fixture('observed-then-gone.js', 'content')
    store.observe(url)
    rmSync(fileURLToPath(url))
    // the observation finds nothing to record, and the old record must not
    // outlive it
    expect(store.observe(url)).to.be.undefined
    expect(store.expand(pathToFileURL(fixtureDir).href, [])).to.deep.equal([])
  })

  it('drops the record of a url that now resolves elsewhere', () => {
    const store = new IdentityStore()
    const first = resolve(fixtureDir, 'retarget-a')
    const second = resolve(fixtureDir, 'retarget-b')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    writeFileSync(resolve(first, 'index.js'), 'a')
    writeFileSync(resolve(second, 'index.js'), 'b')
    const link = resolve(fixtureDir, 'retarget-link')
    const kind = process.platform === 'win32' ? 'junction' : undefined
    symlinkSync(first, link, kind)
    const url = pathToFileURL(resolve(link, 'index.js')).href
    store.observe(url)

    // a retargeted link makes the same url name a different file, and the
    // record of the old one describes nothing that is loaded any more
    rmSync(link, { recursive: true, force: true })
    symlinkSync(second, link, kind)
    store.observe(url)
    expect(store.expand(pathToFileURL(first).href, [])).to.deep.equal([])
    expect(store.expand(pathToFileURL(second).href, [])).to.deep.equal([])
  })

  it('sees a size change under a stamp that did not move', () => {
    const url = fixture('grown.js', 'aaaa')
    const path = fileURLToPath(url)
    // an old stamp is trusted, so no hash is recorded and the size is the only
    // field that can tell the two versions apart
    const t = Date.now() / 1000 - 5
    utimesSync(path, t, t)
    const store = new IdentityStore(0)
    store.observe(url)
    writeFileSync(path, 'aaaaaaaa')
    utimesSync(path, t, t)
    expect(store.changed(url)).to.equal(true)
  })

  it('has nothing to expand for a root that names no path', () => {
    const store = new IdentityStore()
    const url = fixture('named.js', 'content')
    store.observe(url)
    // neither a `file:` URL nor a path that resolves: nothing can be under it
    expect(store.expand('data:text/javascript,1', [])).to.deep.equal([])
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
})
