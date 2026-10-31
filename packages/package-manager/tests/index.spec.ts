import { Context } from 'cordis'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import PackageManager, { adapters, createEnv, run, which } from '../src/index.ts'
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
  packageManager: () => Promise<string>
  files: (cache: string) => Record<string, string>
  lockfile: string
}

const fixtures: Fixture[] = [{
  name: 'npm',
  packageManager: async () => {
    const env = createEnv()
    const { stdout } = await run(which('npm', env)!, ['--version'], { cwd: temp, env })
    return `npm@${stdout.trim()}`
  },
  files: cache => ({
    '.npmrc': `registry=${registry.url}\ncache=${cache}\naudit=false\nfund=false\nupdate-notifier=false\n`,
  }),
  lockfile: 'package-lock.json',
}, {
  name: 'pnpm',
  packageManager: async () => 'pnpm@10.33.0',
  files: cache => ({
    '.npmrc': `registry=${registry.url}\n`,
    'pnpm-workspace.yaml': [
      'nodeLinker: hoisted',
      `storeDir: ${JSON.stringify(join(cache, 'store'))}`,
      `cacheDir: ${JSON.stringify(join(cache, 'cache'))}`,
      '',
    ].join('\n'),
  }),
  lockfile: 'pnpm-lock.yaml',
}, {
  name: 'yarn classic',
  packageManager: async () => 'yarn@1.22.19',
  files: cache => ({
    '.yarnrc': `registry "${registry.url}"\ncache-folder ${JSON.stringify(cache)}\n`,
  }),
  lockfile: 'yarn.lock',
}, {
  name: 'yarn berry',
  packageManager: async () => 'yarn@4.14.1',
  files: cache => ({
    '.yarnrc.yml': [
      'nodeLinker: node-modules',
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
  }),
  lockfile: 'yarn.lock',
}]

let counter = 0

function createProject(files: Record<string, string>) {
  const dir = join(temp, `project-${++counter}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
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

/** The version of every package directory under the `node_modules` of `dir`, by location. */
function scanVersions(dir: string) {
  const result: Record<string, string> = {}
  const walk = (folder: string) => {
    const path = join(dir, folder)
    if (!existsSync(path)) return
    for (const dirent of readdirSync(path, { withFileTypes: true })) {
      if (dirent.name.startsWith('.')) continue
      const location = `${folder}/${dirent.name}`
      if (dirent.name.startsWith('@')) {
        for (const scoped of readdirSync(join(dir, location))) visit(`${location}/${scoped}`)
      } else {
        visit(location)
      }
    }
  }
  const visit = (location: string) => {
    const manifest = join(dir, location, 'package.json')
    if (!existsSync(manifest)) return
    result[location] = JSON.parse(readFileSync(manifest, 'utf8')).version
    walk(`${location}/node_modules`)
  }
  walk('node_modules')
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

function locations(dir: string, changes: PackageManager.InstallResult['added']) {
  return changes.map(change => toPosix(relative(dir, change.path))).sort()
}

/** The changes implied by two scans. A content change without a version change does not occur here. */
function expectDiff(dir: string, result: PackageManager.InstallResult, before: Record<string, string>, after: Record<string, string>) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  expect(locations(dir, result.added)).to.deep.equal(keys.filter(key => !(key in before)))
  expect(locations(dir, result.removed)).to.deep.equal(keys.filter(key => !(key in after)))
  expect(locations(dir, result.updated)).to.deep.equal(keys.filter(key => key in before && key in after && before[key] !== after[key]))
  for (const change of [...result.added, ...result.updated]) {
    expect(change.after?.version).to.equal(after[toPosix(relative(dir, change.path))])
  }
  for (const change of [...result.removed, ...result.updated]) {
    expect(change.before?.version).to.equal(before[toPosix(relative(dir, change.path))])
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
      ...fixture.files(join(temp, `cache-${fixture.name.replace(' ', '-')}`)),
    })
    pm = await setup(dir)
    // a project has a lockfile before the service changes it
    const agent = await pm.agent()
    await run(agent.executable, adapters[agent.kind].installArgs, { cwd: dir, env: createEnv() })
  })

  it('detects the agent', async () => {
    const agent = await pm.agent()
    expect(agent.kind).to.equal(fixture.name.replace(' ', '-'))
  })

  it('adds packages', async () => {
    const before = scanVersions(dir)
    const result = await pm.install({ alpha: '2.0.0', beta: '1.0.0' })
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies).to.deep.equal({ alpha: '2.0.0', beta: '1.0.0' })
    const after = scanVersions(dir)
    expect(after['node_modules/alpha']).to.equal('2.0.0')
    expect(after['node_modules/beta']).to.equal('1.0.0')
    expectDiff(dir, result, before, after)
  })

  it('updates and removes packages in one run', async () => {
    const before = scanVersions(dir)
    const result = await pm.install([['alpha', null], ['gamma', '1.0.0'], ['beta', '^1.0.0']])
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies).to.deep.equal({ beta: '^1.0.0', gamma: '1.0.0' })
    const after = scanVersions(dir)
    expect(Object.entries(after).filter(([key]) => key.endsWith('/alpha')).map(([, version]) => version)).to.deep.equal(['1.0.0'])
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

  it('restores the project when the installation is aborted', async () => {
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
    const before = scanVersions(dir)
    const result = await pm.install({ alpha: '2.0.0' })
    expectDiff(dir, result, before, scanVersions(dir))
  })
})

describe('layout', () => {
  it('rejects a project without a lockfile', async () => {
    const manifest = JSON.stringify({ name: 'project', packageManager: await fixtures[0].packageManager() })
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
    ['npm with a linked strategy', fixtures[0], { '.npmrc': 'install-strategy=linked\n' }],
    ['pnpm with an isolated linker', fixtures[1], { 'pnpm-workspace.yaml': 'nodeLinker: isolated\n' }],
    ['yarn berry with pnp', fixtures[3], { '.yarnrc.yml': 'nodeLinker: pnp\n', 'yarn.lock': '' }],
  ] as const)('rejects %s', async (_, fixture, files) => {
    const manifest = JSON.stringify({ name: 'project', packageManager: await fixture.packageManager() })
    const dir = createProject({ 'package.json': manifest, ...files })
    const pm = await setup(dir)
    await expect(pm.install({ alpha: '1.0.0' })).rejects.toThrow('only')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).to.equal(manifest)
    expect(existsSync(join(dir, 'node_modules'))).to.equal(false)
  })
})
