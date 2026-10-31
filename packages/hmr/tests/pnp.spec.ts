import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Yarn PnP resolves a package through `.pnp.cjs`, not through `node_modules`.
// The official ESM loader is what feeds a `file:` URL to Node; the HMR engine
// then sees an ordinary module URL and can evict it. This test covers that
// path, not a zip-level package update: the fixture dependency is a `portal:`
// directory, so the PnP resolution machinery is real while the package update
// is a file change inside the resolved directory.
//
// Linux only: on Windows, Node 24's ESM loader rejects the drive-letter URL
// produced by Yarn 4.14's `.pnp.loader.mjs` with ERR_UNSUPPORTED_ESM_URL_SCHEME
// (measured locally). CI does not need a skipped test to claim that platform.
const pnpPlatform = process.platform === 'linux'
const testDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(testDir, '../../..')
const fixture = join(tmpdir(), `cordis-pnp-${process.pid}`)
const bundle = join(fixture, 'workspace.bundle.mjs')

let error: unknown

beforeAll(async () => {
  if (!pnpPlatform) return
  try {
    mkdirSync(join(fixture, 'dep'), { recursive: true })
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({
      name: 'cordis-pnp-fixture',
      private: true,
      type: 'module',
      packageManager: 'yarn@4.14.1',
      dependencies: { 'pnp-dep': 'portal:./dep' },
    }, null, 2) + '\n')
    writeFileSync(join(fixture, '.yarnrc.yml'), [
      'nodeLinker: pnp',
      'enableGlobalCache: false',
      'compressionLevel: 0',
      '',
    ].join('\n'))
    writeFileSync(join(fixture, 'dep/package.json'), JSON.stringify({
      name: 'pnp-dep',
      version: '0.0.0',
      type: 'module',
      exports: './index.js',
    }, null, 2) + '\n')
    writeFileSync(join(fixture, 'dep/index.js'), "export const value = 'v1'\n")
    writeFileSync(join(fixture, 'plugin.mjs'), [
      "import { value } from 'pnp-dep'",
      '',
      "export const name = 'pnp'",
      '',
      'export function apply(ctx) {',
      "  ctx.on('pnp/value', () => value)",
      '}',
      '',
    ].join('\n'))

    // A PnP project outside the workspace: a lockfile makes Yarn treat it as
    // a separate project, and the portal dependency needs no network.
    writeFileSync(join(fixture, 'yarn.lock'), '')
    try {
      execFileSync('corepack', ['yarn@4.14.1', 'install', '--no-immutable'], { cwd: fixture, stdio: 'pipe', timeout: 180000, env: { ...process.env, NODE_OPTIONS: '' } })
    } catch (caught: any) {
      throw new Error('yarn install failed: ' + (caught.stdout || '').toString() + '\n' + (caught.stderr || '').toString())
    }

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

    writeFileSync(join(fixture, 'probe.mjs'), [
      "import { writeFileSync } from 'node:fs'",
      "import { pathToFileURL } from 'node:url'",
      `const { Context, Loader, Hmr } = await import(${JSON.stringify(pathToFileURL(bundle).href)})`,
      '',
      'const ctx = new Context()',
      `await ctx.plugin(Loader, { baseUrl: ${JSON.stringify(pathToFileURL(join(fixture, 'entry.mjs')).href)} })`,
      'await ctx.plugin(Hmr)',
      "const id = await ctx.loader.create({ name: './plugin.mjs' })",
      'await ctx.loader.store[id].innerFiber.await().catch(() => {})',
      "const before = ctx.bail('pnp/value')",
      `writeFileSync(${JSON.stringify(join(fixture, 'dep/index.js'))}, "export const value = 'v2'\\n")`,
      `const result = await ctx.hmr.reconcile({ files: [${JSON.stringify(join(fixture, 'dep/index.js'))}] })`,
      "const after = ctx.bail('pnp/value')",
      "console.log('PNP ' + JSON.stringify({ before, after, settled: result.settledFibers.length }))",
      '',
    ].join('\n'))
  } catch (caught) {
    error = caught
  }
}, 180000)

afterAll(() => {
  if (pnpPlatform) rmSync(fixture, { recursive: true, force: true })
})

describe('Yarn PnP', () => {
  const run = pnpPlatform ? it : it.skip
  run('loads and reloads a plugin through .pnp.cjs', () => {
    if (error) throw error
    const output = execFileSync(process.execPath, [
      '--expose-internals',
      '--require', join(fixture, '.pnp.cjs'),
      '--experimental-loader', join(fixture, '.pnp.loader.mjs'),
      'probe.mjs',
    ], { cwd: fixture, encoding: 'utf8', timeout: 120000, env: { ...process.env, NODE_OPTIONS: '' } })
    const line = output.split('\n').find(item => item.startsWith('PNP '))
    expect(line, output.slice(-800)).to.be.ok
    const result = JSON.parse(line!.slice(4))
    expect(result).to.deep.equal({ before: 'v1', after: 'v2', settled: 1 })
  }, 180000)
})
