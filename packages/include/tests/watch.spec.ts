import MemoryFs from '@cordisjs/fs-memory'
import { Watcher } from '@cordisjs/fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import * as yaml from 'yaml'
import { harness, component } from './utils.ts'

// records the watches that it serves
class WatchedFs extends MemoryFs {
  static paths: string[] = []

  watch(watcher: Watcher) {
    WatchedFs.paths.push(fileURLToPath(watcher.url))
    return super.watch(watcher)
  }
}

describe('Include watch', () => {
  const { setup } = harness({ Provider: WatchedFs })

  afterEach(() => {
    WatchedFs.paths = []
  })

  it('does not watch the config file by default', async () => {
    await setup('watch.yml', '[]\n')
    expect(WatchedFs.paths).to.deep.equal([])
  })

  it('watches the config file with `watch: true`', async () => {
    const app = await setup('watch.yml', '[]\n', { watch: true })
    expect(WatchedFs.paths).to.deep.equal([app.filename])
  })

  it('restarts when `watch` is toggled', async () => {
    const app = await setup('watch.yml', '[]\n')
    await app.ctx.loader.update(app.id, { config: { path: './fixtures/watch.yml', watch: true } })
    await app.ctx.loader.store[app.id]!.innerFiber!.await()
    expect(WatchedFs.paths).to.deep.equal([app.filename])
  })

  it('keeps watching the file across its own rename-based writes', async () => {
    const app = await setup('watch-fs.yml', [component('a', 0)], { watch: true })
    const refresh = vi.spyOn(app.include(), 'refresh')

    // two runtime writes, each replacing the file through a rename
    for (const value of [1, 2]) {
      await app.update('a', { config: { tag: 'a', value } })
      await app.include().refresh()
    }
    expect(await app.text()).toContain('value: 2')
    const settled = refresh.mock.calls.length

    // an external edit reaches the tree through the watch alone
    const external = yaml.stringify([component('a', 3)])
    await app.write(external)
    await app.include().flush()
    await app.ctx.loader.await()
    expect(app.config('a')?.value).toBe(3)

    // and the writes of the include itself do not start a feedback loop
    expect(refresh.mock.calls.length - settled).toBeLessThanOrEqual(3)
    expect(await app.text()).toBe(external)
  }, 10000)
})
