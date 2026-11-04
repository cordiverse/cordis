import { Context, Fiber } from 'cordis'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import Fs from '../src/index.ts'

// `subst` maps a drive letter onto a temp directory, so a recursive watch on the
// "volume root" is measurable here without aiming one at a real volume.
const VOL = 'X:'
const BACKING = join(tmpdir(), 'cordis-watch-volume-root')

// the first write can precede the watcher being ready
async function writeUntil(path: string, cond: () => boolean, content = 'v') {
  for (let i = 0; i < 40 && !cond(); i++) {
    writeFileSync(path, `${content}${i}`)
    await new Promise((done) => setTimeout(done, 100))
  }
}

describe('watch a volume', () => {
  let fiber: Fiber<Context> | undefined

  beforeAll(() => {
    if (process.platform !== 'win32') return
    rmSync(BACKING, { recursive: true, force: true })
    mkdirSync(join(BACKING, 'inner', 'deep'), { recursive: true })
    writeFileSync(join(BACKING, 'inner', 'deep', 'nested.yml'), 'v0')
    writeFileSync(join(BACKING, 'sibling.yml'), 'v0')
    try {
      execFileSync('cmd', ['/c', 'subst', VOL, BACKING], { stdio: 'pipe' })
    } catch {}
  })

  afterAll(() => {
    if (process.platform !== 'win32') return
    try {
      execFileSync('cmd', ['/c', 'subst', VOL, '/D'], { stdio: 'pipe' })
    } catch {}
    // Not `rmSync`: the sandbox routes it through a safe-delete shim that fails
    // on a tree the watcher has just released. `rd` is the shell's own removal.
    try {
      execFileSync('cmd', ['/c', 'rd', '/s', '/q', BACKING], { stdio: 'pipe' })
    } catch {}
  })

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
  })

  // the string form falls through to `resolve('X:')`, which is already absolute
  it.runIf(process.platform === 'win32')('rejects a drive-relative path instead of watching the volume', async () => {
    if (!existsSync(VOL + '\\')) return
    const ctx = new Context()
    fiber = await ctx.plugin(Fs)
    const seen: string[] = []

    // thrown synchronously from `_resolve`, before the watcher exists
    expect(() => ctx.fs.watch(VOL)).to.throw(/drive-relative form/)
    // the watch was refused, so no number of writes may deliver
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(BACKING, 'sibling.yml'), `after${i}`)
      await new Promise((done) => setTimeout(done, 300))
    }

    // nothing outside a directory the caller never named reaches the callback
    expect(seen, 'a rejected watch still delivered files from the volume').to.deep.equal([])
  }, 30_000)

  // naming the volume root and naming a file on it are different requests
  it.runIf(process.platform === 'win32')('bounds a file at the volume root but not the volume root itself', async () => {
    if (!existsSync(VOL + '\\')) return
    const ctx = new Context()
    fiber = await ctx.plugin(Fs)
    const seen: string[] = []
    const named = join(VOL + '\\', 'sibling.yml')

    // subscribed on the returned `Watcher`, as the listener is now the options
    const watcher = ctx.fs.watch(named)
    watcher.on('change', (path) => seen.push(path))
    await new Promise<void>((done) => watcher.on('ready', done))

    const arrived = () => seen.some((path) => path.endsWith('sibling.yml'))
    await writeUntil(join(BACKING, 'sibling.yml'), arrived)
    writeFileSync(join(BACKING, 'inner', 'deep', 'nested.yml'), 'v1')
    await new Promise((done) => setTimeout(done, 500))

    // `depth: 0` and the exact-name filter: the nested file is out of scope
    expect(seen.filter((path) => path.endsWith('nested.yml'))).to.deep.equal([])
    expect(arrived(), 'the watch did not deliver the file it was asked about').to.be.true
  }, 30_000)
})
