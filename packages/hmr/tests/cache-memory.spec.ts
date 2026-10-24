import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ModuleCache } from '../src/cache.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
// a module in neither cache: an eviction still records a backup for its owner,
// which is what these tests watch the lifetime of
const url = pathToFileURL(resolve(testDir, '__cache__', 'memory-probe.js')).href

function size(cache: ModuleCache) {
  return (cache as any).backups.size
}

describe('Hmr module cache lifetime', () => {
  it('releases the backup of an owner once it is restored', () => {
    const cache = new ModuleCache({ loadCache: new Map() } as any)
    const owner = {}
    cache.evict([url], owner)
    expect(size(cache)).to.equal(1)
    cache.restore(owner)
    expect(size(cache)).to.equal(0)
    // the modules were put back, so the owner has nothing left to hand back
    cache.restore(owner)
    expect(size(cache)).to.equal(0)
  })

  it('drops the backups a committed transaction never restores', () => {
    const cache = new ModuleCache({ loadCache: new Map() } as any)
    cache.evict([url], {})
    cache.evict([url], {})
    expect(size(cache)).to.equal(2)
    cache.clear()
    expect(size(cache)).to.equal(0)
  })

  it('keeps nothing behind after a hundred transactions', () => {
    const cache = new ModuleCache({ loadCache: new Map() } as any)
    let peak = 0
    for (let i = 0; i < 100; i++) {
      // each transaction evicts for its own batch objects and ends
      cache.evict([url], {})
      peak = Math.max(peak, size(cache))
      cache.clear()
      expect(size(cache)).to.equal(0)
    }
    console.log('peak backups within a transaction:', peak)
    expect(peak).to.be.at.most(1)
  })
})
