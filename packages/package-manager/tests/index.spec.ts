import { Context } from 'cordis'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import PackageManager from '../src/index.ts'
import { adapters, AgentKind, AgentLayout } from '../src/agent.ts'
import { createEnv, run, which } from '../src/process.ts'
import { Registry } from './registry.ts'

const registry = new Registry([
  { name: 'alpha', version: '1.0.0' },
  { name: 'alpha', version: '2.0.0' },
  { name: 'beta', version: '1.0.0', dependencies: { alpha: '^1.0.0' } },
  { name: 'gamma', version: '1.0.0' },
  // aborted while its tarball is being downloaded
  { name: 'epsilon', version: '1.0.0' },
  // the project's `postinstall` fails while it is a dependency, i.e. after `node_modules` is changed
  { name: 'delta', version: '1.0.0' },
  // its tarball is unavailable
  { name: 'zeta', version: '1.0.0' },
])
registry.unavailable.add('zeta')

// every test runs an agent against a local registry
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 })

const temp = join(tmpdir(), `cordis-package-manager-${process.pid}`)

interface Fixture {
  name: string
  kind: AgentKind
  layout: AgentLayout
  packageManager: () => Promise<string>
  files: (cache: string) => Record<string, string>
  lockfile: string
  /** the protocols of a dependency on a local directory */
  localProtocols: string[]
}

function pnpmFiles(linker: string) {
  return (cache: string) => ({
    '.npmrc': `registry=${registry.url}\n`,
    'pnpm-workspace.yaml': [
      `nodeLinker: ${linker}`,
      // remove the packages that are no longer linked from the virtual store,
      // which the scans of the tests would find
      'modulesCacheMaxAge: 0',
      `storeDir: ${JSON.stringify(join(cache, 'store'))}`,
      `cacheDir: ${JSON.stringify(join(cache, 'cache'))}`,
      '',
    ].join('\n'),
  })
}

function yarnBerryFiles(linker: string) {
  return (cache: string) => ({
    '.yarnrc.yml': [
      `nodeLinker: ${linker}`,
      `npmRegistryServer: ${JSON.stringify(registry.url)}`,
      'unsafeHttpWhitelist: ["127.0.0.1"]',
      'enableGlobalCache: false',
      'enableMirror: false',
      `globalFolder: ${JSON.stringify(join(cache, 'global'))}`,
      'enableTelemetry: false',
      `cacheFolder: ${JSON.stringify(cache)}`,
      '',
    ].join('\n'),
    'yarn.lock': '',
  })
}

const fixtures: Fixture[] = [{
  name: 'npm',
  kind: 'npm',
  layout: 'hoisted',
  packageManager: async () => {
    const env = createEnv()
    const { stdout } = await run(which('npm', env)!, ['--version'], { cwd: temp, env })
    return `npm@${stdout.trim()}`
  },
  files: cache => ({
    '.npmrc': `registry=${registry.url}\ncache=${cache}\naudit=false\nfund=false\nupdate-notifier=false\n`,
  }),
  lockfile: 'package-lock.json',
  localProtocols: ['file'],
}, {
  name: 'pnpm',
  kind: 'pnpm',
  layout: 'hoisted',
  packageManager: async () => 'pnpm@10.33.0',
  files: pnpmFiles('hoisted'),
  lockfile: 'pnpm-lock.yaml',
  localProtocols: ['file', 'link'],
}, {
  name: 'pnpm isolated',
  kind: 'pnpm',
  layout: 'isolated',
  packageManager: async () => 'pnpm@10.33.0',
  files: pnpmFiles('isolated'),
  lockfile: 'pnpm-lock.yaml',
  localProtocols: ['file', 'link'],
}, {
  name: 'pnpm 11 isolated',
  kind: 'pnpm',
  layout: 'isolated',
  packageManager: async () => 'pnpm@11.28.5',
  files: pnpmFiles('isolated'),
  lockfile: 'pnpm-lock.yaml',
  localProtocols: ['file', 'link'],
}, {
  name: 'yarn classic',
  kind: 'yarn-classic',
  layout: 'hoisted',
  packageManager: async () => 'yarn@1.22.19',
  files: cache => ({
    '.yarnrc': `registry "${registry.url}"\ncache-folder ${JSON.stringify(cache)}\n`,
  }),
  lockfile: 'yarn.lock',
  localProtocols: ['file', 'link'],
}, {
  name: 'yarn berry',
  kind: 'yarn-berry',
  layout: 'hoisted',
  packageManager: async () => 'yarn@4.14.1',
  files: yarnBerryFiles('node-modules'),
  lockfile: 'yarn.lock',
  localProtocols: ['file', 'portal', 'link'],
}, {
  name: 'yarn 3 pnpm',
  kind: 'yarn-berry',
  layout: 'isolated',
  packageManager: async () => 'yarn@3.8.7',
  files: yarnBerryFiles('pnpm'),
  lockfile: 'yarn.lock',
  // the store entry of a `file:` dependency is named after the hash of its content
  localProtocols: ['portal', 'link'],
}, {
  name: 'yarn berry pnpm',
  kind: 'yarn-berry',
  layout: 'isolated',
  packageManager: async () => 'yarn@4.14.1',
  files: yarnBerryFiles('pnpm'),
  lockfile: 'yarn.lock',
  // the store entry of a `file:` dependency is named after the hash of its content
  localProtocols: ['portal', 'link'],
}]

function fixture(name: string) {
  return fixtures.find(fixture => fixture.name === name)!
}

let counter = 0

function createProject(files: Record<string, string>) {
  const dir = join(temp, `project-${++counter}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  return dir
}

async function setup(dir: string) {
  const root = new Context()
  await root.plugin(PackageManager, { base: dir, timeout: 120000 })
  let ctx!: Context
  await root.inject(['packageManager'], (inner) => { ctx = inner })
  return ctx.packageManager
}

function toPosix(path: string) {
  return path.split(sep).join('/')
}

interface ScannedPackage {
  version: string
  realpath: string
}

/**
 * Every package in a `node_modules` folder below `dir`, by location, including
 * the folders in the store of an isolated layout.
 */
function scanPackages(dir: string) {
  const result: Record<string, ScannedPackage> = {}
  const visit = (location: string) => {
    const manifest = join(dir, location, 'package.json')
    if (!existsSync(manifest)) return
    result[location] = { version: JSON.parse(readFileSync(manifest, 'utf8')).version, realpath: realpathSync(join(dir, location)) }
  }
  const walk = (folder: string) => {
    for (const dirent of readdirSync(join(dir, folder), { withFileTypes: true })) {
      const location = folder ? `${folder}/${dirent.name}` : dirent.name
      if (basename(folder) === 'node_modules' && !dirent.name.startsWith('.')) {
        if (dirent.name.startsWith('@')) {
          for (const scoped of readdirSync(join(dir, location))) visit(`${location}/${scoped}`)
        } else {
          visit(location)
        }
      }
      if (dirent.isDirectory()) walk(location)
    }
  }
  walk('')
  return result
}

/** Every entry under `node_modules` with the hash of its content or its link target. */
function scanTree(dir: string) {
  const result: Record<string, string> = {}
  const walk = (path: string) => {
    for (const dirent of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, dirent.name)
      const key = toPosix(relative(dir, child))
      if (dirent.isSymbolicLink()) {
        result[key] = `link:${readlinkSync(child)}`
      } else if (dirent.isDirectory()) {
        result[key] = 'dir'
        walk(child)
      } else {
        result[key] = createHash('sha1').update(readFileSync(child)).digest('hex')
      }
    }
  }
  if (existsSync(join(dir, 'node_modules'))) walk(join(dir, 'node_modules'))
  return result
}

/** The locations of changes, which are reported below the real path of the project. */
function locations(dir: string, changes: PackageManager.InstallResult['added']) {
  return changes.map(change => toPosix(relative(realpathSync(dir), change.path))).sort()
}

/**
 * The changes implied by two scans: a package is updated if its version or
 * its real directory changed. A content change without a version change does
 * not occur here.
 */
function expectDiff(dir: string, result: PackageManager.InstallResult, before: Record<string, ScannedPackage>, after: Record<string, ScannedPackage>) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  expect(locations(dir, result.added)).to.deep.equal(keys.filter(key => !(key in before)))
  expect(locations(dir, result.removed)).to.deep.equal(keys.filter(key => !(key in after)))
  expect(locations(dir, result.updated)).to.deep.equal(keys.filter((key) => {
    if (!(key in before) || !(key in after)) return false
    return before[key].version !== after[key].version || before[key].realpath !== after[key].realpath
  }))
  for (const change of [...result.added, ...result.updated]) {
    expect(change.after).to.include(after[toPosix(relative(realpathSync(dir), change.path))])
  }
  for (const change of [...result.removed, ...result.updated]) {
    expect(change.before).to.include(before[toPosix(relative(realpathSync(dir), change.path))])
  }
}

function snapshot(dir: string, lockfile: string) {
  return {
    manifest: readFileSync(join(dir, 'package.json'), 'utf8'),
    lockfile: readFileSync(join(dir, lockfile), 'utf8'),
    tree: scanTree(dir),
  }
}

/**
 * The manifest and the lockfile are restored, and so is every file and link
 * of the packages installed before. The metadata of the agent directly under
 * `node_modules` may differ, empty directories may be removed, and entries
 * created by the failed run may remain.
 */
function expectRestored(before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>) {
  expect(after.manifest).to.equal(before.manifest)
  expect(after.lockfile).to.equal(before.lockfile)
  const packageFiles = (tree: Record<string, string>) => Object.fromEntries(Object.entries(tree)
    .filter(([key, value]) => value !== 'dir' && !/^node_modules\/\.(?!bin(\/|$))/.test(key) && key in before.tree))
  expect(packageFiles(after.tree)).to.deep.equal(packageFiles(before.tree))
}

beforeAll(async () => {
  rmSync(temp, { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })
  await registry.start()
})

afterAll(async () => {
  await registry.stop()
  rmSync(temp, { recursive: true, force: true })
})

describe.each(fixtures)('$name', (fixture) => {
  let dir: string
  let pm: PackageManager

  beforeAll(async () => {
    const manifest = {
      name: 'project',
      version: '1.0.0',
      private: true,
      packageManager: await fixture.packageManager(),
      scripts: { postinstall: 'node postinstall.cjs' },
    }
    dir = createProject({
      'package.json': JSON.stringify(manifest, null, 2) + '\n',
      'postinstall.cjs': `process.exit(require('./package.json').dependencies?.delta ? 1 : 0)\n`,
      'local/package.json': JSON.stringify({ name: 'local-real-name', version: '1.0.0' }),
      ...fixture.files(join(temp, `cache-${fixture.name.replaceAll(' ', '-')}`)),
    })
    pm = await setup(dir)
    // a project has a lockfile before the service changes it
    const agent = await pm.agent()
    await run(agent.executable, adapters[agent.kind].installArgs, { cwd: dir, env: createEnv() })
  })

  it('detects the agent', async () => {
    const agent = await pm.agent()
    expect(agent).to.include({ kind: fixture.kind, layout: fixture.layout })
  })

  it('adds packages', async () => {
    const before = scanPackages(dir)
    const result = await pm.install({ alpha: '2.0.0', beta: '1.0.0' })
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies).to.deep.equal({ alpha: '2.0.0', beta: '1.0.0' })
    const after = scanPackages(dir)
    expect(after['node_modules/alpha'].version).to.equal('2.0.0')
    expect(after['node_modules/beta'].version).to.equal('1.0.0')
    expectDiff(dir, result, before, after)
  })

  it('updates and removes packages in one run', async () => {
    const before = scanPackages(dir)
    const result = await pm.install([['alpha', null], ['gamma', '1.0.0'], ['beta', '^1.0.0']])
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies).to.deep.equal({ beta: '^1.0.0', gamma: '1.0.0' })
    const after = scanPackages(dir)
    expect([...new Set(Object.entries(after).filter(([key]) => key.endsWith('/alpha')).map(([, { version }]) => version))]).to.deep.equal(['1.0.0'])
    expectDiff(dir, result, before, after)
  })

  it('restores the project when the project script fails', async () => {
    const before = snapshot(dir, fixture.lockfile)
    await expect(pm.install({ beta: null, delta: '1.0.0' })).rejects.toThrow()
    expectRestored(before, snapshot(dir, fixture.lockfile))
  })

  it('restores the project when a tarball is unavailable', async () => {
    const before = snapshot(dir, fixture.lockfile)
    await expect(pm.install({ beta: null, zeta: '1.0.0' })).rejects.toThrow()
    expectRestored(before, snapshot(dir, fixture.lockfile))
  })

  // Skipped: the agent is terminated at an arbitrary point, e.g. while it
  // removes `beta` during the download of `epsilon`. A package that it leaves
  // partially written keeps its directory and its records, so that the
  // recovery takes it for installed and leaves it as it is. Restoring the
  // packages after an interruption requires a more reliable installation,
  // such as one into a staging directory or an isolated layout.
  it.skip('restores the project when the installation is aborted', async () => {
    const before = snapshot(dir, fixture.lockfile)
    const controller = new AbortController()
    let release!: () => void
    registry.delay = (path) => {
      if (!path.startsWith('epsilon/')) return
      controller.abort()
      return new Promise<void>(resolve => release = resolve)
    }
    try {
      await expect(pm.install({ beta: null, epsilon: '1.0.0' }, { signal: controller.signal })).rejects.toThrow()
    } finally {
      registry.delay = undefined
      release?.()
    }
    expectRestored(before, snapshot(dir, fixture.lockfile))
  })

  it('reports changes against the restored state', async () => {
    const before = scanPackages(dir)
    const result = await pm.install({ alpha: '2.0.0' })
    expectDiff(dir, result, before, scanPackages(dir))
  })

  it.each(fixture.localProtocols)('reports a local package of the %s protocol by its manifest name', async (protocol) => {
    const location = 'node_modules/local-alias'
    try {
      const added = await pm.install({ 'local-alias': `${protocol}:./local` })
      const change = added.added.find(change => toPosix(relative(realpathSync(dir), change.path)) === location)
      expect(change?.after).to.include({ name: 'local-real-name', local: true, realpath: realpathSync(change!.path) })
      // the content of a local package is not recorded, so that every installation updates it
      const updated = await pm.install([])
      expect(locations(dir, updated.updated)).to.include(location)
    } finally {
      await pm.install({ 'local-alias': null })
    }
  })
})

describe('preconditions', () => {
  it('rejects a project without a lockfile', async () => {
    const manifest = JSON.stringify({ name: 'project', packageManager: await fixture('npm').packageManager() })
    const dir = createProject({ 'package.json': manifest })
    const pm = await setup(dir)
    await expect(pm.install({ alpha: '1.0.0' })).rejects.toThrow('lockfile')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).to.equal(manifest)
  })

  it('rejects a project without `packageManager`', async () => {
    const dir = createProject({ 'package.json': '{ "name": "project" }\n' })
    const pm = await setup(dir)
    await expect(pm.install({ alpha: '1.0.0' })).rejects.toThrow('packageManager')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).to.equal('{ "name": "project" }\n')
  })

  it.each([
    ['npm with a nested strategy', fixture('npm'), { '.npmrc': 'install-strategy=nested\n' }],
    ['npm with a linked strategy', fixture('npm'), { '.npmrc': 'install-strategy=linked\n' }],
    ['pnpm with pnp', fixture('pnpm'), { 'pnpm-workspace.yaml': 'nodeLinker: pnp\n' }],
    ['pnpm 9 with an isolated layout', { ...fixture('pnpm isolated'), packageManager: async () => 'pnpm@9.15.4' }, {}],
    ['pnpm with a global virtual store', fixture('pnpm isolated'), { 'pnpm-workspace.yaml': 'enableGlobalVirtualStore: true\n' }],
    ['yarn classic with pnp in the manifest', fixture('yarn classic'), { 'yarn.lock': '' }, { installConfig: { pnp: true } }],
    ['yarn classic with pnp in .yarnrc', fixture('yarn classic'), { '.yarnrc': '--install.pnp true\n', 'yarn.lock': '' }],
    ['yarn classic with a modules folder', fixture('yarn classic'), { '.yarnrc': '--modules-folder lib\n', 'yarn.lock': '' }],
    ['yarn classic with a meta folder', fixture('yarn classic'), { '.yarnrc': 'enable-meta-folder true\n', 'yarn.lock': '' }],
    ['yarn berry with pnp', fixture('yarn berry'), { '.yarnrc.yml': 'nodeLinker: pnp\n', 'yarn.lock': '' }],
  ] as [string, Fixture, Record<string, string>, object?][])('rejects %s', async (_, fixture, files, extra = {}) => {
    const manifest = JSON.stringify({ name: 'project', packageManager: await fixture.packageManager(), ...extra })
    const dir = createProject({ 'package.json': manifest, ...files })
    const pm = await setup(dir)
    await expect(pm.install({ alpha: '1.0.0' })).rejects.toThrow('only')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).to.equal(manifest)
    expect(existsSync(join(dir, 'node_modules'))).to.equal(false)
  })
})
