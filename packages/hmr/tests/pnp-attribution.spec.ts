import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IdentityStore } from '../src/identity.ts'
import { isPnpSignal, pnpUrls } from '../src/index.ts'

// A Yarn PnP package update reports `.pnp.cjs` and a new archive, neither of
// which is a module URL. This pins the attribution that turns such a signal
// into the modules the archive served, so `reconcile` reloads them.
//
// The fixture uses a `file:` tarball rather than a `portal:` directory: only a
// tarball is fetched into a cache as an archive, which is what makes the module
// URL contain the archive path.
//
// Two layouts are covered, because the archive's location is configurable:
// - project cache (`.yarn/cache`), the default;
// - global cache (`enableGlobalCache: true`), where the archive lives outside
//   the project under `YARN_GLOBAL_FOLDER`.
//
// Linux only, for the same reason `pnp.spec.ts` is: on Windows, Node 24's ESM
// loader rejects the drive-letter URL that Yarn 4.14's `.pnp.loader.mjs`
// produces with ERR_UNSUPPORTED_ESM_URL_SCHEME.
const pnpPlatform = process.platform === 'linux'
const testDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(testDir, '../../..')

interface Fixture {
  dir: string
  env?: NodeJS.ProcessEnv
  error?: unknown
}

const fixtures: Record<string, Fixture> = {}

function tarball(dir: string, version: string, value: string) {
  mkdirSync(join(dir, 'pack', 'package'), { recursive: true })
  writeFileSync(join(dir, 'pack', 'package', 'package.json'), JSON.stringify({
    name: 'zip-dep', version, type: 'module', exports: './index.js',
  }, null, 2) + '\n')
  writeFileSync(join(dir, 'pack', 'package', 'index.js'), `export const value = '${value}'\n`)
  execFileSync('tar', ['czf', `zip-dep-${version}.tgz`, '-C', 'pack', 'package'], { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'cordis-pnp-attr-fixture',
    private: true,
    type: 'module',
    packageManager: 'yarn@4.14.1',
    dependencies: { 'zip-dep': `file:./zip-dep-${version}.tgz` },
  }, null, 2) + '\n')
}

async function makeFixture(tag: string, globalCache: boolean) {
  const dir = join(tmpdir(), `cordis-pnp-attr-${tag}-${process.pid}`)
  const bundle = join(dir, 'workspace.bundle.mjs')
  const globalFolder = join(dir, '.global')
  const env = globalCache
    ? { ...process.env, YARN_GLOBAL_FOLDER: globalFolder, NODE_OPTIONS: '' }
    : { ...process.env, NODE_OPTIONS: '' }

  mkdirSync(dir, { recursive: true })
  tarball(dir, '1.0.0', 'v1')
  writeFileSync(join(dir, '.yarnrc.yml'), [
    'nodeLinker: pnp',
    `enableGlobalCache: ${globalCache}`,
    'compressionLevel: 0',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'yarn.lock'), '')
  execFileSync('corepack', ['yarn@4.14.1', 'install', '--no-immutable'], {
    cwd: dir, stdio: 'pipe', timeout: 180000, env,
  })
  writeFileSync(join(dir, 'plugin.mjs'), [
    "import { value } from 'zip-dep'",
    '',
    "export const name = 'zip'",
    '',
    'export function apply(ctx) {',
    "  ctx.on('zip/value', () => value)",
    '}',
    '',
  ].join('\n'))

  await build({
    stdin: {
      contents: [
        "export { Context } from 'cordis'",
        "export { default as Loader } from '@cordisjs/plugin-loader'",
        `export { default as Hmr } from ${JSON.stringify(resolve(root, 'packages/hmr/src/index.ts'))}`,
      ].join('\n'),
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    alias: {
      cordis: resolve(root, 'packages/core/src/index.ts'),
      '@cordisjs/plugin-loader': resolve(root, 'packages/loader/src/index.ts'),
      '@cordisjs/loader-utils': resolve(root, 'packages/loader-utils/src/index.ts'),
    },
    logLevel: 'silent',
  })

  writeFileSync(join(dir, 'probe.mjs'), [
    "import { execFileSync } from 'node:child_process'",
    "import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "import { pathToFileURL } from 'node:url'",
    `const { Context, Loader, Hmr } = await import(${JSON.stringify(pathToFileURL(bundle).href)})`,
    `const env = ${JSON.stringify(globalCache ? { YARN_GLOBAL_FOLDER: globalFolder } : {})}`,
    '',
    'const ctx = new Context()',
    `await ctx.plugin(Loader, { baseUrl: ${JSON.stringify(pathToFileURL(join(dir, 'entry.mjs')).href)} })`,
    'await ctx.plugin(Hmr)',
    "const id = await ctx.loader.create({ name: './plugin.mjs' })",
    'await ctx.loader.store[id].innerFiber.await().catch(() => {})',
    "const before = ctx.bail('zip/value')",
    '',
    "const cache = " + JSON.stringify(globalCache ? globalFolder + '/cache' : join(dir, '.yarn', 'cache')),
    "const beforeArchives = new Set(readdirSync(cache).filter((name) => name.endsWith('.zip')))",
    '',
    '// a second version, installed the way a package manager does it',
    "mkdirSync('pack2/package', { recursive: true })",
    "writeFileSync('pack2/package/package.json', JSON.stringify({ name: 'zip-dep', version: '1.0.1', type: 'module', exports: './index.js' }, null, 2) + '\\n')",
    "writeFileSync('pack2/package/index.js', \"export const value = 'v2'\\n\")",
    "execFileSync('tar', ['czf', 'zip-dep-1.0.1.tgz', '-C', 'pack2', 'package'])",
    "writeFileSync('package.json', JSON.stringify({ name: 'cordis-pnp-attr-fixture', private: true, type: 'module', packageManager: 'yarn@4.14.1', dependencies: { 'zip-dep': 'file:./zip-dep-1.0.1.tgz' } }, null, 2) + '\\n')",
    "execFileSync('corepack', ['yarn@4.14.1', 'install', '--no-immutable'], { stdio: 'pipe', env: { ...process.env, ...env } })",
    '',
    '// the signal is the new archive, wherever the cache put it',
    "// a global cache keeps the archive it served before, so the update is whichever one is new",
    "const fresh = readdirSync(cache).filter((name) => name.endsWith('.zip') && !beforeArchives.has(name))",
    "if (!fresh.length) throw new Error('yarn install produced no new archive in ' + cache)",
    "const archive = join(cache, fresh[0])",
    "const zipOf = (value) => (value.match(/[^/]+\\.zip/) || ['none'])[0]",
    "// pnpapi re-reads `.pnp.cjs` at most once per 500ms: poll for the new",
    "// archive rather than guessing how long the install took",
    "const deadline = Date.now() + 3000",
    "while (Date.now() < deadline && !import.meta.resolve('zip-dep').includes(zipOf(archive))) {",
    '  await new Promise((resolve) => setTimeout(resolve, 50))',
    '}',
    'const result = await ctx.hmr.reconcile({ files: [archive] })',
    "const after = ctx.bail('zip/value')",
    "const resolved = import.meta.resolve('zip-dep')",
    "console.log('PNP ' + JSON.stringify({ before, after, replaced: result.settledFibers.length, outside: !archive.includes('.yarn/cache'), fresh: fresh.length, archive: archive.split('/').pop(), resolvedZip: zipOf(resolved), archiveZip: zipOf(archive) }))",
    '',
  ].join('\n'))

  return { dir, env }
}

beforeAll(async () => {
  if (!pnpPlatform) return
  for (const [tag, globalCache] of [['project', false], ['global', true]] as const) {
    try {
      fixtures[tag] = await makeFixture(tag, globalCache)
    } catch (caught) {
      fixtures[tag] = { dir: '', error: caught }
    }
  }
}, 300000)

afterAll(() => {
  if (!pnpPlatform) return
  for (const fixture of Object.values(fixtures)) {
    if (fixture.dir) rmSync(fixture.dir, { recursive: true, force: true })
  }
})

// The attribution itself is unit-tested below. These end-to-end cases run the
// real Yarn 4 PnP loader in a child process: the probe imports v1, then a second
// child process runs `yarn install` for a v2 tarball. `pnpapi` re-reads
// `.pnp.cjs` at most once per 500ms, so the probe polls `import.meta.resolve`
// for up to 3s until it names the new archive. The cases assert that the
// archive signal reached the plugin (`before: 'v1'`, `replaced: 1`), that
// resolution names the new archive, that the reloaded plugin imports v2, and
// the cache layout.
describe('Yarn PnP archive attribution (end to end)', () => {
  const run = pnpPlatform ? it : it.skip
  for (const [tag, label] of [['project', 'a project cache'], ['global', 'a global cache']] as const) {
    run(`reloads the modules an archive served (${label})`, () => {
      const fixture = fixtures[tag]!
      if (fixture.error) throw fixture.error
      const output = execFileSync(process.execPath, [
        '--expose-internals',
        '--require', join(fixture.dir, '.pnp.cjs'),
        '--experimental-loader', join(fixture.dir, '.pnp.loader.mjs'),
        'probe.mjs',
      ], { cwd: fixture.dir, encoding: 'utf8', timeout: 180000, env: fixture.env })
      const line = output.split('\n').find(item => item.startsWith('PNP '))
      expect(line, output.slice(-1200)).to.be.ok
      const result = JSON.parse(line!.slice(4))
      // the attribution itself: the archive signal must reach the plugin
      expect(result, JSON.stringify(result)).to.deep.include({ before: 'v1', replaced: 1 })
      // resolution must name the new archive, not the one the process loaded
      // first
      expect(result.resolvedZip, JSON.stringify(result)).to.equal(result.archiveZip)
      // and the reloaded plugin must import the new value, not the old module
      expect(result.after, JSON.stringify(result)).to.equal('v2')
      // the global layout is what makes this a second case rather than a repeat
      expect(result.outside).to.equal(tag === 'global')
    }, 240000)
  }
})

describe('PnP archive attribution', () => {
  it('recognizes an archive or its manifest as a signal, wherever the cache is', () => {
    expect(isPnpSignal(pathToFileURL('/p/.yarn/cache/a-file-1-2.zip').href)).to.equal(true)
    expect(isPnpSignal('/home/u/.yarn/berry/cache/a-file-1-2.zip')).to.equal(true)
    expect(isPnpSignal('/p/.pnp.cjs')).to.equal(true)
    expect(isPnpSignal(pathToFileURL('/p/.yarn/unplugged/a/node_modules/a/index.js').href)).to.equal(false)
    expect(isPnpSignal(pathToFileURL('/p/src/index.ts').href)).to.equal(false)
  })

  it('collects the modules an archive served from the ESM cache', () => {
    const archived = pathToFileURL('/p/.yarn/cache/a-file-1-2.zip/node_modules/a/index.js').href
    const sibling = pathToFileURL('/p/.yarn/cache/b-file-3-4.zip/node_modules/b/index.js').href
    const unplugged = pathToFileURL('/p/.yarn/unplugged/a/node_modules/a/index.js').href
    const plain = pathToFileURL('/p/src/index.ts').href
    const loadCache = new Map([[archived, {}], [sibling, {}], [unplugged, {}], [plain, {}]])
    const urls = pnpUrls({ loadCache } as any, new IdentityStore())
    // the widening is coarse on purpose: a signal names one archive, but the
    // batch takes every archived module, so a second archive is included and
    // only the unplugged and plain paths are left out
    expect(urls).to.deep.equal([archived, sibling, unplugged])
  })

  it('collects a module that was evicted from every cache but is still recorded', () => {
    const archived = pathToFileURL('/p/.yarn/cache/a-file-1-2.zip/node_modules/a/index.js').href
    const identity = new IdentityStore()
    // an archive path cannot be stat-ed, so the record is seeded directly: the
    // point is that a record survives when both caches no longer hold it
    ;(identity as any).records.set('/p/.yarn/cache/a-file-1-2.zip/node_modules/a/index.js', {
      path: '/p/.yarn/cache/a-file-1-2.zip/node_modules/a/index.js',
      url: archived,
      dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n, observedAt: 0,
    })
    const urls = pnpUrls({ loadCache: new Map() } as any, identity)
    expect(urls).to.deep.equal([archived])
  })
})
