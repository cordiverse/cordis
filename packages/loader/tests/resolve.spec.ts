import { expect, describe, it, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, Logger, Message } from 'cordis'
import { Loader } from '../src'
import { createResolve } from '../src/resolve'

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

  // `import.meta.resolve` anchors its failure on the helper file inside
  // `.cordis`, which the user never wrote.
  it('names the config file when a bare specifier cannot be resolved', async () => {
    const { baseUrl } = await fixture()
    const tree = await treeFor(baseUrl)
    await expect(tree.import('definitely-not-installed-xyz'))
      .rejects.toThrow(`cannot resolve definitely-not-installed-xyz from ${baseUrl}`)
  })

  // A failed `import()` here anchors on this file, which is cordis' own source.
  it('names the config file when a relative specifier cannot be resolved', async () => {
    const { baseUrl } = await fixture()
    const tree = await treeFor(baseUrl)
    await expect(tree.import('./definitely-missing.js'))
      .rejects.toThrow(`cannot resolve ./definitely-missing.js from ${baseUrl}`)
  })

  // No `package.json` above the config file leaves no project to resolve in.
  it('names the config file when no project can be located', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cordis-noproj-'))
    roots.push(root)
    const baseUrl = pathToFileURL(join(root, 'cordis.yml')).href
    const tree = await treeFor(baseUrl)
    await expect(tree.import('definitely-not-installed-xyz'))
      .rejects.toThrow(`cannot resolve definitely-not-installed-xyz from ${baseUrl}`)
  })

  // A resolved specifier can still point at a file that is gone.
  it('names the config file when a resolved specifier cannot be imported', async () => {
    const { root, baseUrl } = await fixture()
    await rm(join(root, 'node_modules', 'fixture-dep', 'index.js'))
    const tree = await treeFor(baseUrl)
    await expect(tree.import('fixture-dep'))
      .rejects.toThrow(`cannot resolve fixture-dep from ${baseUrl}`)
  })

  // A builtin is looked up before any `import()`, so it is reported on its own.
  it('names the config file when the builtin is unknown', async () => {
    const { baseUrl } = await fixture()
    const tree = await treeFor(baseUrl)
    expect(() => tree.import('cordis:definitely-not-a-builtin'))
      .to.throw(`cannot resolve cordis:definitely-not-a-builtin from ${baseUrl}`)
  })

  // Only a missing module is re-anchored; a module that throws keeps its stack.
  it('keeps the original error when the module itself throws', async () => {
    const { root, baseUrl } = await fixture()
    await writeFile(join(root, 'src', 'boom.js'), 'throw new Error("boom from the module")\n')
    const tree = await treeFor(baseUrl)
    await expect(tree.import('./boom.js')).rejects.toThrow('boom from the module')
  })

  // `baseUrl` is optional, so a loader without one is a supported state.
  it('omits the location when there is no base url', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.internal = undefined
    await expect(ctx.loader.root.tree.import('definitely-not-installed-xyz'))
      .rejects.toThrow('cannot resolve definitely-not-installed-xyz')
    await expect(ctx.loader.root.tree.import('definitely-not-installed-xyz'))
      .rejects.not.toThrow('undefined')
  })

  // A relative specifier needs a base url, and without one it is the specifier
  // that is reported, not `new URL`'s own TypeError.
  it('names a relative specifier when there is no base url', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.internal = undefined
    await expect(ctx.loader.root.tree.import('./definitely-missing.js'))
      .rejects.toThrow('cannot resolve ./definitely-missing.js')
    await expect(ctx.loader.root.tree.import('./definitely-missing.js'))
      .rejects.not.toThrow('Invalid URL')
  })

  // The path a user takes: the loader initialises the entry, which catches the
  // failure and reports it. Assert on what lands in the log, not on a throw.
  it('reports the config file when an entry fails to load', async () => {
    const { baseUrl } = await fixture()
    const ctx = new Context()
    await ctx.plugin(Loader, { baseUrl })
    ctx.loader.internal = undefined
    const messages: Message[] = []
    ctx.logger.exporter({ colors: false, export: message => messages.push(message) })
    await ctx.loader.create({ name: 'definitely-not-installed-xyz' })
    await ctx.loader.await()
    const text = messages.map(message => Logger.format({ colors: false }, message)).join('\n')
    expect(text).to.include(`cannot resolve definitely-not-installed-xyz from ${baseUrl}`)
  })

  // A config file can leave `name` out of an entry, and the loader must name
  // the missing field rather than surface a bare TypeError of its own.
  it('names the missing field when an entry has no name', async () => {
    const { baseUrl } = await fixture()
    const tree = await treeFor(baseUrl)
    expect(() => tree.import(undefined as any)).to.throw('entry name is required')
  })

  // A nameless entry reports through the same log path.
  it('reports a missing entry name in the log', async () => {
    const { baseUrl } = await fixture()
    const ctx = new Context()
    await ctx.plugin(Loader, { baseUrl })
    ctx.loader.internal = undefined
    const messages: Message[] = []
    ctx.logger.exporter({ colors: false, export: message => messages.push(message) })
    await ctx.loader.create({ group: true } as any)
    await ctx.loader.await()
    const text = messages.map(message => Logger.format({ colors: false }, message)).join('\n')
    expect(text).to.include('entry name is required')
  })

  it('names a relative specifier without baseUrl even when internal loader is active', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader)
    // Keep internal loader if present
    await expect(ctx.loader.root.tree.import('./missing-under-internal.js'))
      .rejects.toThrow('cannot resolve ./missing-under-internal.js')
  })

  it('omits the location for bare specifiers without baseUrl when internal loader is active', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader)
    // Keep internal loader if present
    await expect(ctx.loader.root.tree.import('definitely-not-installed-xyz'))
      .rejects.toThrow('cannot resolve definitely-not-installed-xyz')
    await expect(ctx.loader.root.tree.import('definitely-not-installed-xyz'))
      .rejects.not.toThrow('undefined')
  })

  // A plugin that is present but whose own dependency is missing is not a config
  // mistake: Node's error names the dependency, which is what the user must fix.
  // Run in a child process because vitest's module runner drops `error.url`,
  // which is the signal the plain `import()` path reads.
  it('keeps the dependency name when the plugin is present but its dependency is missing', function (ctx) {
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
    let stdout: string
    try {
      stdout = execSync('node --import tsx --input-type=module', {
        cwd: repoRoot,
        input: `
          import { Context } from "./packages/core/src/index.ts"
          import { Loader } from "./packages/loader/src/index.ts"
          import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
          import { tmpdir } from "node:os"
          import { join } from "node:path"
          import { pathToFileURL } from "node:url"

          const root = await mkdtemp(join(tmpdir(), "cordis-dep-"))
          await mkdir(join(root, "src"), { recursive: true })
          await writeFile(join(root, "package.json"), JSON.stringify({ name: "x", type: "module" }))
          await writeFile(join(root, "src", "plugin.js"), "import \\"./missing-dep.js\\"")
          const baseUrl = pathToFileURL(join(root, "src", "cordis.yml")).href

          const ctx = new Context()
          await ctx.plugin(Loader, { baseUrl })
          ctx.loader.internal = undefined
          try {
            await ctx.loader.root.tree.import("./plugin.js")
            console.log("REPORTED=" + JSON.stringify({ threw: false }))
          } catch (error) {
            console.log("REPORTED=" + JSON.stringify({ message: String(error.message).split("\\n")[0] }))
          }
        `,
        encoding: 'utf-8',
      })
    } catch (error: any) {
      if (error.code === 'ENOENT') return ctx.skip()
      throw error
    }
    const match = stdout.match(/REPORTED=(\{.*\})/)
    expect(match, stdout).to.be.ok
    const report = JSON.parse(match![1])
    expect(report.message, stdout).to.include('missing-dep.js')
    expect(report.message, stdout).not.to.include('cannot resolve ./plugin.js')
  })

  // The internal loader reports the same way, so the two paths stay in step.
  it('keeps the dependency name on the internal loader path', async () => {
    const { root, baseUrl } = await fixture()
    await writeFile(join(root, 'src', 'plugin.js'), 'import "./missing-dep.js"\n')
    const ctx = new Context()
    await ctx.plugin(Loader, { baseUrl })
    expect(ctx.loader.internal, 'internals are reachable under vitest').to.be.ok
    await expect(ctx.loader.root.tree.import('./plugin.js')).rejects.toThrow('missing-dep.js')
    await expect(ctx.loader.root.tree.import('./plugin.js')).rejects.not.toThrow('cannot resolve ./plugin.js')
  })

  // When a plugin fails because its own bare npm dependency is missing, Node drops `error.url`;
  // the loader must still preserve the missing dependency error rather than re-anchoring.
  it('keeps the bare dependency name on the internal loader path', async () => {
    const { root, baseUrl } = await fixture()
    await writeFile(join(root, 'src', 'plugin.js'), 'import "missing-subdep-xyz"\n')
    const ctx = new Context()
    await ctx.plugin(Loader, { baseUrl })
    expect(ctx.loader.internal, 'internals are reachable under vitest').to.be.ok
    await expect(ctx.loader.root.tree.import('./plugin.js')).rejects.toThrow('missing-subdep-xyz')
    await expect(ctx.loader.root.tree.import('./plugin.js')).rejects.not.toThrow('cannot resolve ./plugin.js')
  })

  // Calling `ctx.loader.import()` directly rebinds `ctx` via Service.tracker;
  // it must still resolve relative specifiers against the loader tree's baseUrl.
  it('resolves relative specifiers when called directly on ctx.loader', async () => {
    const { root, baseUrl } = await fixture()
    await writeFile(join(root, 'src', 'plugin.js'), 'export const tag = "relative"\n')
    const ctx = new Context()
    await ctx.plugin(Loader, { baseUrl })
    ctx.loader.internal = undefined
    expect((await ctx.loader.import('./plugin.js')).tag).to.equal('relative')
  })
})
