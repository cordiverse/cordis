import { expect, describe, it, beforeAll, afterAll, afterEach } from 'vitest'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import { Loader } from '../src/index.ts'
import { createResolve } from '../src/resolve.ts'

const roots: string[] = []

/**
 * A project with its own bare dependency and a config file one level below the
 * `package.json`, so the scope root is never the directory the base url points
 * at. The dependency exposes only an `import` condition.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cordis-resolve-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fixture-app',
    type: 'module',
    imports: { '#local': './local.js' },
    exports: { './sub': './sub.js' },
  }))
  await writeFile(join(root, 'local.js'), 'export const tag = "subpath-import"\n')
  await writeFile(join(root, 'sub.js'), 'export const tag = "self-reference"\n')
  const dep = join(root, 'node_modules', 'fixture-dep')
  await mkdir(dep, { recursive: true })
  await writeFile(join(dep, 'package.json'), JSON.stringify({
    name: 'fixture-dep',
    type: 'module',
    exports: { '.': { import: './index.js' } },
  }))
  await writeFile(join(dep, 'index.js'), 'export const tag = "bare-dep"\n')
  await mkdir(join(root, 'src'))
  return { root, baseUrl: pathToFileURL(join(root, 'src', 'cordis.yml')).href }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('bareImporter', () => {
  it('resolves bare specifiers against the project, not the loader', async () => {
    const { baseUrl } = await fixture()
    // The control: this package cannot see the fixture's dependency.
    await expect(import(/* @vite-ignore */ 'fixture-dep')).rejects.toThrow()

    const resolver = await createResolve(baseUrl)
    expect(resolver).to.be.ok
    expect((await import(resolver!('fixture-dep'))).tag).to.equal('bare-dep')
  })

  it('keeps subpath imports and self references working', async () => {
    const { baseUrl } = await fixture()
    const resolver = await createResolve(baseUrl)
    expect((await import(resolver!('#local'))).tag).to.equal('subpath-import')
    expect((await import(resolver!('fixture-app/sub'))).tag).to.equal('self-reference')
  })

  it('anchors the helper at the package.json, not at the base url', async () => {
    const { root, baseUrl } = await fixture()
    await createResolve(baseUrl)
    expect(existsSync(join(root, '.cordis', 'resolve.mjs'))).to.be.true
    expect(existsSync(join(root, 'src', '.cordis'))).to.be.false
  })

  it('makes the helper directory ignore itself', async () => {
    const { root, baseUrl } = await fixture()
    await createResolve(baseUrl)
    const content = await readFile(join(root, '.cordis', '.gitignore'), 'utf8')
    expect(content).to.include('*')
  })

  it('reuses one helper per scope', async () => {
    const { root } = await fixture()
    const a = await createResolve(pathToFileURL(join(root, 'cordis.yml')).href)
    const b = await createResolve(pathToFileURL(join(root, 'src', 'nested.yml')).href)
    expect(a).to.equal(b)
  })

  it('declines when there is no project to anchor to', async () => {
    expect(await createResolve(undefined)).to.be.undefined
    expect(await createResolve('https://example.com/cordis.yml')).to.be.undefined
  })
})

describe('helper preparation', () => {
  const stale = 'export default () => "stale"\n'
  const renames = { path: '', calls: 0, failures: 0, code: 'EBUSY' }
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const actualRename = fsp.rename

  // Node opens files with FILE_SHARE_DELETE on Windows, so openSync('r')
  // does not block replacement. Inject failures and sync the builtin ESM
  // bindings so the resolver observes them through either module loader.
  beforeAll(() => {
    fsp.rename = async (from, to) => {
      if (to === renames.path) {
        renames.calls++
        if (renames.failures > 0) {
          renames.failures--
          throw Object.assign(new Error(`${renames.code}: rename failed`), { code: renames.code })
        }
      }
      return actualRename(from, to)
    }
    syncBuiltinESMExports()
  })

  afterAll(() => {
    fsp.rename = actualRename
    syncBuiltinESMExports()
  })

  afterEach(() => {
    Object.assign(renames, { path: '', calls: 0, failures: 0, code: 'EBUSY' })
  })

  async function prepareHelper() {
    const { root, baseUrl } = await fixture()
    const dir = join(root, '.cordis')
    const helper = join(dir, 'resolve.mjs')
    await mkdir(dir)
    await writeFile(helper, stale)
    renames.path = helper
    return { baseUrl, dir, helper }
  }

  it('reuses an identical helper without attempting rename', async () => {
    // Copy a generated helper into a scope that has not been cached yet.
    const source = await fixture()
    await createResolve(source.baseUrl)
    const { baseUrl, helper } = await prepareHelper()
    await copyFile(join(source.root, '.cordis', 'resolve.mjs'), helper)
    renames.failures = Infinity

    const resolver = await createResolve(baseUrl)
    expect(renames.calls).to.equal(0)
    expect((await import(resolver!('fixture-dep'))).tag).to.equal('bare-dep')
  })

  it.each(['EACCES', 'EPERM', 'EBUSY'])('retries a stale helper after %s', async (code) => {
    const { baseUrl } = await prepareHelper()
    renames.code = code
    renames.failures = 2

    const resolver = await createResolve(baseUrl)
    expect(renames.calls).to.equal(3)
    expect((await import(resolver!('fixture-dep'))).tag).to.equal('bare-dep')
  })

  it.each([
    { code: 'EBUSY', attempts: 11 },
    { code: 'ENOSPC', attempts: 1 },
  ])('cleans up after $code and recovers on a later call', async ({ code, attempts }) => {
    const { baseUrl, dir, helper } = await prepareHelper()
    renames.code = code
    renames.failures = Infinity

    expect(await createResolve(baseUrl)).to.be.undefined
    expect(renames.calls).to.equal(attempts)
    expect(await readFile(helper, 'utf8')).to.equal(stale)
    expect((await readdir(dir)).sort()).to.deep.equal(['.gitignore', 'resolve.mjs'])

    renames.failures = 0
    const resolver = await createResolve(baseUrl)
    expect(renames.calls).to.equal(attempts + 1)
    expect((await import(resolver!('fixture-dep'))).tag).to.equal('bare-dep')
  })
})

describe('EntryTree.import without internals', () => {
  // Plugins are loaded through `entry.parent.tree`, which carries the tree's own
  // base url; the `ctx.loader` accessor rebinds `ctx` to whoever reads it.
  async function treeFor(baseUrl: string) {
    const ctx = new Context()
    await ctx.plugin(Loader, { baseUrl })
    ctx.loader.internal = undefined
    return ctx.loader.root.tree
  }

  // The helper's presence is what marks this branch as taken.
  it('routes bare specifiers to the project helper', async () => {
    const { root, baseUrl } = await fixture()
    const tree = await treeFor(baseUrl)
    expect((await tree.import('fixture-dep')).tag).to.equal('bare-dep')
    expect(existsSync(join(root, '.cordis', 'resolve.mjs'))).to.be.true
  })

  it('still resolves relative specifiers against the base url', async () => {
    const { root, baseUrl } = await fixture()
    await writeFile(join(root, 'src', 'plugin.js'), 'export const tag = "relative"\n')
    const tree = await treeFor(baseUrl)
    expect((await tree.import('./plugin.js')).tag).to.equal('relative')
    expect(existsSync(join(root, '.cordis'))).to.be.false
  })

  it.runIf(process.platform === 'win32')('accepts a drive-letter path', async () => {
    const { root, baseUrl } = await fixture()
    const pluginPath = join(root, 'src', 'abs-plugin.mjs')
    await writeFile(pluginPath, 'export const tag = "win-abs"\n')
    const tree = await treeFor(baseUrl)
    expect((await tree.import(pluginPath)).tag).to.equal('win-abs')
  })
})
