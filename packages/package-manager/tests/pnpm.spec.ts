import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readPnpmIsolatedState } from '../src/readers/pnpm.ts'
import { createDepPathToFilename } from '../src/readers/pnpm-path.ts'
import { diffState } from '../src/state.ts'
import { createProject } from './utils.ts'

describe('pnpm isolated', () => {
  interface PnpmOptions {
    files?: Record<string, unknown>
    dir?: string
    modules?: Record<string, unknown> | null
    workspaceState?: Record<string, unknown>
    snapshotFields?: Record<string, Record<string, Record<string, string>>>
    /**
     * The links a filtered installation created, each from a location below
     * `node_modules` to its target: a dependency path for a store entry,
     * `local:<dir>` for a local directory, or `null` for a broken link. A
     * missing location has no link.
     */
    installedLinks?: Record<string, string | null>
  }

  /** the store directory of a simple dependency path `<name>@<version>` */
  const depPathDir = (depPath: string) => `node_modules/.pnpm/${depPath}/node_modules/${depPath.split('@')[0]}`

  /** a project installed with the current lockfile, by importer and by snapshot */
  function pnpmProject(importers: Record<string, Record<string, string>>, snapshots: Record<string, Record<string, string>>, options: PnpmOptions = {}) {
    const { files = {}, dir, modules, workspaceState, snapshotFields = {}, installedLinks } = options
    const root = createProject({
      ...modules === null ? {} : {
        'node_modules/.modules.yaml': JSON.stringify({ packageManager: 'pnpm@10.33.0', virtualStoreDir: '.pnpm', virtualStoreDirMaxLength: 120, ...modules }),
      },
      'node_modules/.pnpm/lock.yaml': JSON.stringify({
        lockfileVersion: '9.0',
        importers: Object.fromEntries(Object.entries(importers).map(([id, deps]) => [id, {
          dependencies: Object.fromEntries(Object.entries(deps).map(([alias, version]) => [alias, { specifier: version, version }])),
        }])),
        snapshots: Object.fromEntries(Object.entries(snapshots).map(([depPath, dependencies]) => [depPath, { dependencies, ...snapshotFields[depPath] }])),
      }),
      ...workspaceState ? { 'node_modules/.pnpm-workspace-state-v1.json': JSON.stringify(workspaceState) } : {},
      ...files,
    }, dir)
    // the links a filtered installation created, each to a store directory,
    // to a local directory (`local:<dir>`), or nowhere (`null`)
    for (const [location, depPath] of Object.entries(installedLinks ?? {})) {
      const link = join(root, location)
      mkdirSync(dirname(link), { recursive: true })
      if (depPath === null) {
        symlinkSync(join(root, 'node_modules/.pnpm/missing'), link, 'junction')
      } else if (depPath.startsWith('local:')) {
        symlinkSync(join(root, depPath.slice('local:'.length)), link, 'junction')
      } else {
        const target = join(root, depPathDir(depPath))
        mkdirSync(target, { recursive: true })
        writeFileSync(join(target, 'package.json'), JSON.stringify({ name: depPath.split('@')[0], version: depPath.split('@')[1] }))
        symlinkSync(target, link, 'junction')
      }
    }
    return root
  }

  it('updates a dependency whose link between packages is retargeted', async () => {
    const dir = pnpmProject({ '.': { beta: '1.0.0' } }, { 'beta@1.0.0': { alpha: '1.0.0' }, 'alpha@1.0.0': {} })
    const before = await readPnpmIsolatedState(dir)
    pnpmProject({ '.': { beta: '1.0.0' } }, { 'beta@1.0.0': { alpha: '1.1.0' }, 'alpha@1.1.0': {} }, { dir })
    const after = await readPnpmIsolatedState(dir)
    const location = 'node_modules/.pnpm/beta@1.0.0/node_modules/alpha'
    const diff = diffState(dir, before, after)
    expect(diff.updated.map(change => change.path)).to.deep.equal([join(dir, location)])
    expect(diff.updated[0].before?.realpath.endsWith(join('.pnpm/alpha@1.0.0/node_modules/alpha'))).to.equal(true)
    expect(diff.updated[0].after?.realpath.endsWith(join('.pnpm/alpha@1.1.0/node_modules/alpha'))).to.equal(true)
    expect(before.get(location)).to.include({ version: '1.0.0', local: false })
    expect(after.get(location)).to.include({ version: '1.1.0', local: false })
  })

  it('reads the dependencies of every importer', async () => {
    const dir = pnpmProject({ '.': {}, 'packages/foo': { alpha: '1.0.0' } }, { 'alpha@1.0.0': {} })
    const state = await readPnpmIsolatedState(dir)
    expect(state.get('packages/foo/node_modules/alpha')).to.include({
      name: 'alpha',
      version: '1.0.0',
      realpath: join(realpathSync(dir), 'node_modules/.pnpm/alpha@1.0.0/node_modules/alpha'),
    })
  })

  it('treats a package from a local directory as local', async () => {
    const dir = pnpmProject({ '.': { copied: 'local@file:local', linked: 'link:local' } }, { 'local@file:local': {} }, {
      files: { 'local/package.json': { name: 'local', version: '1.0.0' } },
    })
    const state = await readPnpmIsolatedState(dir)
    expect(state.get('node_modules/copied')).to.include({ name: 'local', local: true })
    expect(state.get('node_modules/linked')).to.include({ name: 'local', local: true, realpath: join(realpathSync(dir), 'local') })
  })

  it('reads a link against a project without `.modules.yaml`', async () => {
    const dir = pnpmProject({ '.': { linked: 'link:local' } }, {}, {
      modules: null,
      files: { 'local/package.json': { name: 'local', version: '1.0.0' } },
    })
    const state = await readPnpmIsolatedState(dir)
    expect(state.get('node_modules/linked')).to.include({ name: 'local', local: true, realpath: join(realpathSync(dir), 'local') })
  })

  it('omits an optional dependency that the installation excludes', async () => {
    const dir = pnpmProject({ '.': { opt: '1.0.0' } }, { 'opt@1.0.0': {}, 'alpha@1.0.0': {} }, {
      modules: { included: { dependencies: true, devDependencies: true, optionalDependencies: false } },
      snapshotFields: { 'opt@1.0.0': { optionalDependencies: { alpha: '1.0.0' } } },
    })
    const state = await readPnpmIsolatedState(dir)
    expect(state.has('node_modules/.pnpm/opt@1.0.0/node_modules/alpha')).to.equal(false)
    expect(state.has('node_modules/.pnpm/opt@1.0.0/node_modules/opt')).to.equal(true)
  })

  it('omits the links that a filtered installation did not create', async () => {
    const dir = pnpmProject({ '.': {}, 'packages/wsp': { alpha: '1.0.0' }, 'packages/other': { beta: '1.0.0' } }, { 'alpha@1.0.0': {}, 'beta@1.0.0': {} }, {
      workspaceState: { filteredInstall: true, projects: {} },
      // only `wsp` was installed; the uninstalled importer has an unrelated folder
      installedLinks: { 'packages/wsp/node_modules/alpha': 'alpha@1.0.0' },
      files: { 'packages/other/node_modules/.cache/x': '' },
    })
    const state = await readPnpmIsolatedState(dir)
    expect(state.get('packages/wsp/node_modules/alpha')).to.include({ name: 'alpha', version: '1.0.0', local: false })
    expect(state.has('packages/other/node_modules/beta')).to.equal(false)
  })

  it('reads the actual target of a link a filtered installation left unchanged', async () => {
    // the lockfile records `beta@2.0.0`, but the link still points to `beta@1.0.0`
    const dir = pnpmProject({ '.': {}, 'packages/other': { beta: '2.0.0' } }, { 'beta@2.0.0': {} }, {
      workspaceState: { filteredInstall: true, projects: {} },
      installedLinks: { 'packages/other/node_modules/beta': 'beta@1.0.0' },
    })
    const state = await readPnpmIsolatedState(dir)
    expect(state.get('packages/other/node_modules/beta')).to.include({
      name: 'beta',
      version: '1.0.0',
      realpath: realpathSync(join(dir, 'node_modules/.pnpm/beta@1.0.0/node_modules/beta')),
    })
  })

  it('reads the actual target of a local link a filtered installation left unchanged', async () => {
    // the lockfile declares a registry dependency, but the link still points to a local directory
    const dir = pnpmProject({ '.': {}, 'packages/other': { dep: '1.0.0' } }, { 'dep@1.0.0': {} }, {
      workspaceState: { filteredInstall: true, projects: {} },
      installedLinks: { 'packages/other/node_modules/dep': 'local:local' },
      files: { 'local/package.json': { name: 'old-package', version: '9.9.9' } },
    })
    const state = await readPnpmIsolatedState(dir)
    expect(state.get('packages/other/node_modules/dep')).to.include({
      name: 'old-package',
      local: true,
      realpath: realpathSync(join(dir, 'local')),
    })
  })

  it('treats a store entry of a `file:` dependency a filtered installation left unchanged as local', async () => {
    // pnpm copies a `file:` directory into the store and updates the copy in place
    const dir = pnpmProject({ '.': {}, 'packages/other': { dep: '1.0.0' } }, { 'dep@1.0.0': {} }, {
      workspaceState: { filteredInstall: true, projects: {} },
      installedLinks: { 'packages/other/node_modules/dep': 'dep@file+local' },
    })
    const state = await readPnpmIsolatedState(dir)
    expect(state.get('packages/other/node_modules/dep')).to.include({
      local: true,
      realpath: realpathSync(join(dir, 'node_modules/.pnpm/dep@file+local/node_modules/dep')),
    })
  })

  describe('a store entry whose name pnpm truncated', () => {
    const name = '@review/a-long-local-package-name-beyond-the-limit'
    const toFilename = createDepPathToFilename('10.33.0')

    /** a filtered installation that left a link to the store entry of a dependency path */
    async function readLeftLink(depPath: string, snapshots: Record<string, Record<string, string>>) {
      const dir = pnpmProject({ '.': {}, 'packages/other': { [name]: '1.0.0' } }, snapshots, {
        modules: { virtualStoreDirMaxLength: 60 },
        workspaceState: { filteredInstall: true, projects: {} },
      })
      const target = join(dir, 'node_modules/.pnpm', toFilename(depPath, 60), 'node_modules', name)
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
      mkdirSync(join(dir, 'packages/other/node_modules/@review'), { recursive: true })
      symlinkSync(target, join(dir, 'packages/other/node_modules', name), 'junction')
      return (await readPnpmIsolatedState(dir)).get(`packages/other/node_modules/${name}`)
    }

    it('is local for a `file:` dependency path of the lockfile', async () => {
      const depPath = `${name}@file:local`
      // the truncated name does not contain the protocol
      expect(toFilename(depPath, 60)).not.to.match(/file\+/)
      expect(await readLeftLink(depPath, { [depPath]: {}, [`${name}@1.0.0`]: {} })).to.include({ local: true })
    })

    it('is not local for a registry dependency path of the lockfile', async () => {
      const depPath = `${name}@1.0.0`
      expect(await readLeftLink(depPath, { [depPath]: {} })).to.include({ local: false })
    })

    it('is local without a dependency path of the lockfile', async () => {
      expect(await readLeftLink(`${name}@file:local`, { [`${name}@1.0.0`]: {} })).to.include({ local: true })
    })
  })

  it('reads a workspace that a filtered installation hoisted', async () => {
    const dir = pnpmProject({ '.': {}, 'packages/wsp': {} }, {}, {
      modules: { hoistPattern: ['*'] },
      workspaceState: {
        filteredInstall: true,
        settings: { hoistWorkspacePackages: true },
        projects: { 'packages/wsp': { name: 'wsp' }, 'packages/other': { name: 'other' } },
      },
      files: { 'packages/wsp/package.json': { name: 'wsp', version: '1.0.0' } },
    })
    // only `wsp` is hoisted into the shared store folder
    mkdirSync(join(dir, 'node_modules/.pnpm/node_modules'), { recursive: true })
    symlinkSync(join(dir, 'packages/wsp'), join(dir, 'node_modules/.pnpm/node_modules/wsp'), 'junction')
    const state = await readPnpmIsolatedState(dir)
    expect(state.get('node_modules/.pnpm/node_modules/wsp')).to.include({ name: 'wsp', local: true })
    expect(state.has('node_modules/.pnpm/node_modules/other')).to.equal(false)
  })

  it('resolves the real directory of a link through a symlink', async () => {
    const dir = pnpmProject({ '.': { linked: 'link:aliased' } }, {}, {
      modules: null,
      files: { 'real/package.json': { name: 'local', version: '1.0.0' } },
    })
    symlinkSync(join(dir, 'real'), join(dir, 'aliased'), 'junction')
    const state = await readPnpmIsolatedState(dir)
    expect(state.get('node_modules/linked')).to.include({ name: 'local', realpath: realpathSync(join(dir, 'real')) })
  })

  it('resolves each link to the store as Node does, whether absolute or relative', async () => {
    const dir = pnpmProject({ '.': { alpha: '1.0.0', beta: '1.0.0' } }, { 'alpha@1.0.0': {}, 'beta@1.0.0': { alpha: '1.0.0' } })
    for (const depPath of ['alpha@1.0.0', 'beta@1.0.0']) {
      createProject({ [`${depPathDir(depPath)}/package.json`]: { name: depPath.split('@')[0], version: '1.0.0' } }, dir)
    }
    // an absolute link in the native spelling, which may differ from the
    // project root on Windows, and relative links, which pnpm may mix
    symlinkSync(join(realpathSync.native(dir), depPathDir('alpha@1.0.0')), join(dir, 'node_modules/alpha'), 'junction')
    symlinkSync(join('.pnpm/beta@1.0.0/node_modules/beta'), join(dir, 'node_modules/beta'), 'dir')
    symlinkSync(join('../../alpha@1.0.0/node_modules/alpha'), join(dir, 'node_modules/.pnpm/beta@1.0.0/node_modules/alpha'), 'dir')
    const state = await readPnpmIsolatedState(dir)
    for (const location of ['node_modules/alpha', 'node_modules/beta', 'node_modules/.pnpm/beta@1.0.0/node_modules/alpha']) {
      expect(state.get(location)?.realpath).to.equal(realpathSync(join(dir, location)))
    }
  })

  it('rejects the state of an unsupported version of pnpm', async () => {
    const dir = pnpmProject({ '.': {} }, {}, { modules: { packageManager: 'pnpm@12.0.0' } })
    await expect(readPnpmIsolatedState(dir)).rejects.toThrow('pnpm@12.0.0')
  })

  it('names a store entry as pnpm does', () => {
    for (const version of ['10.33.0', '11.28.5']) {
      const toFilename = createDepPathToFilename(version)
      expect(toFilename('peer-user@1.0.0(alpha@2.0.0)', 120)).to.equal('peer-user@1.0.0_alpha@2.0.0')
      expect(toFilename('Upper@1.0.0', 120)).to.equal('Upper@1.0.0_2f38233065cbb506de7089bd7fce2421')
    }
    // since pnpm 11.28.5, locations that escape to the same name are told apart
    const toFilename = createDepPathToFilename('11.28.5')
    expect(toFilename('foo@https://example.com/a#b.tgz', 120)).not.to.equal(toFilename('foo@https://example.com/a+b.tgz', 120))
  })
})
