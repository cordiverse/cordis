import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { serialize } from 'node:v8'
import { gzipSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { diffState, InstallState, PackageState, readNpmState, readYarnBerryState, readYarnClassicState } from '../src/state.ts'
import { createDepPathToFilename, readPnpmIsolatedState, readYarnBerryIsolatedState } from '../src/isolated.ts'

const temp = join(tmpdir(), `cordis-package-manager-state-${process.pid}`)
let counter = 0

function toPosix(path: string) {
  return path.split(sep).join('/')
}

/** Create a project with the files, or write them into an existing one. */
function createProject(files: Record<string, unknown>, dir = join(temp, `project-${++counter}`)) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

afterAll(() => {
  rmSync(temp, { recursive: true, force: true })
})

describe('npm', () => {
  function bundle(integrity: string, version: string) {
    return {
      'node_modules/.package-lock.json': {
        packages: {
          'node_modules/parent': { version, resolved: `https://registry.example/parent-${version}.tgz`, integrity },
          'node_modules/parent/node_modules/child': { version: '1.0.0', inBundle: true },
          'node_modules/parent/node_modules/child/node_modules/grandchild': { version: '1.0.0', inBundle: true },
        },
      },
    }
  }

  it('updates the packages bundled in an updated package', async () => {
    const before = await readNpmState(createProject(bundle('sha512-a', '1.0.0')))
    const after = await readNpmState(createProject(bundle('sha512-b', '2.0.0')))
    const diff = diffState('/', before, after)
    expect(diff.updated.map(change => change.name).sort()).to.deep.equal(['child', 'grandchild', 'parent'])
  })

  it.skipIf(process.platform === 'win32')('reports the real directory below a linked node_modules', async () => {
    const dir = createProject({
      'shared/.package-lock.json': {
        packages: { 'node_modules/alpha': { version: '1.0.0', resolved: 'https://registry.example/alpha-1.0.0.tgz', integrity: 'sha512-a' } },
      },
      'shared/alpha/package.json': { name: 'alpha', version: '1.0.0' },
      'project/package.json': { name: 'project' },
    })
    symlinkSync('../shared', join(dir, 'project/node_modules'), 'dir')
    const state = await readNpmState(join(dir, 'project'))
    expect(state.get('node_modules/alpha')?.realPath).to.equal(realpathSync(join(dir, 'shared/alpha')))
  })
})

describe('yarn classic', () => {
  function bundle(version: string) {
    const url = (name: string, version: string) => `https://registry.example/${name}/-/${name}-${version}.tgz#sha1`
    return {
      'node_modules/.yarn-integrity': {
        modulesFolders: ['node_modules'],
        // the lockfile has an entry for another copy of the bundled package
        lockfileEntries: { [`parent@${version}`]: url('parent', version), 'child@^1.0.0': url('child', '1.0.0') },
      },
      'node_modules/parent/package.json': { name: 'parent', version, bundleDependencies: ['child'] },
      'node_modules/parent/node_modules/child/package.json': { name: 'child', version: '1.0.0' },
      'node_modules/parent/node_modules/child/node_modules/grandchild/package.json': { name: 'grandchild', version: '1.0.0' },
    }
  }

  it('updates the packages bundled in an updated package', async () => {
    const before = await readYarnClassicState(createProject(bundle('1.0.0')))
    const after = await readYarnClassicState(createProject(bundle('2.0.0')))
    const diff = diffState('/', before, after)
    expect(diff.updated.map(change => change.name).sort()).to.deep.equal(['child', 'grandchild', 'parent'])
  })

  /** a project installed with the lockfile entries, each of which lists its patterns, and the packages by location */
  function classicProject(entries: [patterns: string[], version: string, url: string][], packages: Record<string, string>) {
    return {
      'yarn.lock': ['# yarn lockfile v1', '', ...entries.flatMap(([patterns, version, url]) => [
        // quoted as yarn does
        `${patterns.map(pattern => /^[a-z][^\s",:[\]\\]*$/i.test(pattern) ? pattern : JSON.stringify(pattern)).join(', ')}:`,
        `  version "${version}"`,
        `  resolved "${url}"`,
        '',
      ])].join('\n'),
      'node_modules/.yarn-integrity': {
        modulesFolders: ['node_modules'],
        lockfileEntries: Object.fromEntries(entries.flatMap(([patterns, , url]) => patterns.map(pattern => [pattern, url]))),
      },
      ...Object.fromEntries(Object.entries(packages).map(([location, version]) => {
        return [`${location}/package.json`, { name: location.split('/').pop(), version }]
      })),
    }
  }

  it('updates a package whose version has several sources', async () => {
    const dir = createProject(classicProject([
      [['alpha@^1.0.0'], '1.0.0', 'https://registry.example/alpha/-/alpha-1.0.0.tgz#sha1-a'],
      // the name of a tarball does not tell its version
      [['alpha@https://example.com/archive.tgz'], '1.0.0', 'https://example.com/archive.tgz#sha1-b'],
    ], { 'node_modules/alpha': '1.0.0', 'node_modules/beta': '1.0.0', 'node_modules/beta/node_modules/alpha': '1.0.0' }))
    const state = await readYarnClassicState(dir)
    expect(diffState(dir, state, state).updated.map(change => change.path).sort()).to.deep.equal([
      join(dir, 'node_modules/alpha'),
      join(dir, 'node_modules/beta/node_modules/alpha'),
    ])
  })

  it('identifies a version with a single source by that source', async () => {
    const dir = createProject(classicProject([
      // a quoted pattern may contain a comma
      [['alpha@https://example.com/alpha,one.tgz', 'alpha@~1.0.0'], '1.0.0', 'https://example.com/alpha,one.tgz#sha1-a'],
      [['alpha@^2.0.0'], '2.0.0', 'https://registry.example/alpha/-/alpha-2.0.0.tgz#sha1-b'],
    ], { 'node_modules/alpha': '2.0.0', 'node_modules/beta': '1.0.0', 'node_modules/beta/node_modules/alpha': '1.0.0' }))
    const state = await readYarnClassicState(dir)
    expect(state.size).to.equal(3)
    expect(diffState(dir, state, state).updated).to.deep.equal([])
  })
})

describe('yarn berry', () => {
  it('treats a virtual workspace as local', async () => {
    const dir = createProject({
      'packages/foo/package.json': { name: 'foo', version: '1.0.0' },
      'node_modules/.yarn-state.yml': [
        '__metadata:',
        '  version: 1',
        '"foo@virtual:0123abcd#workspace:packages/foo":',
        '  locations:',
        '    - "node_modules/foo"',
        '"bar@virtual:0123abcd#npm:1.2.3":',
        '  locations:',
        '    - "node_modules/bar"',
        '',
      ].join('\n'),
    })
    const state = await readYarnBerryState(dir)
    expect(state.get('node_modules/foo')).to.include({ name: 'foo', local: true })
    expect(state.get('node_modules/bar')).to.include({ name: 'bar', version: '1.2.3', local: false })
    expect(diffState(dir, state, state).updated.map(change => change.name)).to.deep.equal(['foo'])
  })
})

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
    expect(diff.updated[0].before?.realPath.endsWith(join('.pnpm/alpha@1.0.0/node_modules/alpha'))).to.equal(true)
    expect(diff.updated[0].after?.realPath.endsWith(join('.pnpm/alpha@1.1.0/node_modules/alpha'))).to.equal(true)
    expect(before.get(location)).to.include({ version: '1.0.0', local: false })
    expect(after.get(location)).to.include({ version: '1.1.0', local: false })
  })

  it('reads the dependencies of every importer', async () => {
    const dir = pnpmProject({ '.': {}, 'packages/foo': { alpha: '1.0.0' } }, { 'alpha@1.0.0': {} })
    const state = await readPnpmIsolatedState(dir)
    expect(state.get('packages/foo/node_modules/alpha')).to.include({
      name: 'alpha',
      version: '1.0.0',
      realPath: join(realpathSync(dir), 'node_modules/.pnpm/alpha@1.0.0/node_modules/alpha'),
    })
  })

  it('treats a package from a local directory as local', async () => {
    const dir = pnpmProject({ '.': { copied: 'local@file:local', linked: 'link:local' } }, { 'local@file:local': {} }, {
      files: { 'local/package.json': { name: 'local', version: '1.0.0' } },
    })
    const state = await readPnpmIsolatedState(dir)
    expect(state.get('node_modules/copied')).to.include({ name: 'local', local: true })
    expect(state.get('node_modules/linked')).to.include({ name: 'local', local: true, realPath: join(realpathSync(dir), 'local') })
  })

  it('reads a link against a project without `.modules.yaml`', async () => {
    const dir = pnpmProject({ '.': { linked: 'link:local' } }, {}, {
      modules: null,
      files: { 'local/package.json': { name: 'local', version: '1.0.0' } },
    })
    const state = await readPnpmIsolatedState(dir)
    expect(state.get('node_modules/linked')).to.include({ name: 'local', local: true, realPath: join(realpathSync(dir), 'local') })
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
      realPath: realpathSync(join(dir, 'node_modules/.pnpm/beta@1.0.0/node_modules/beta')),
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
      realPath: realpathSync(join(dir, 'local')),
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
      realPath: realpathSync(join(dir, 'node_modules/.pnpm/dep@file+local/node_modules/dep')),
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
    expect(state.get('node_modules/linked')).to.include({ name: 'local', realPath: realpathSync(join(dir, 'real')) })
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

describe.each([
  { format: 'yarn 4', store: (dir: string, hash: string) => [join(dir, 'node_modules/.store', hash, 'package'), join(dir, 'node_modules/.store', hash, 'node_modules')] },
  { format: 'yarn 3', store: (dir: string, hash: string) => [join(dir, 'node_modules/.store', hash, 'node_modules', hash.split('-')[0])] },
])('$format pnpm linker', ({ format, store }) => {
  function ident(name: string) {
    return { identHash: `ident-${name}`, scope: null, name }
  }

  /** the custom data of the pnpm linker of the format, by the location of each package */
  function customData(locations: Map<string, string[]>) {
    if (format === 'yarn 3') {
      return { installersCustomData: new Map([[JSON.stringify({ name: 'PnpmInstaller', version: 2 }), {
        pathByLocator: new Map([...locations].map(([hash, [location]]) => [hash, location])),
        locatorByPath: new Map(),
      }]]) }
    }
    return { linkersCustomData: new Map([[JSON.stringify({ name: 'PnpmLinker', version: 3 }), {
      pathsByLocator: new Map([...locations].map(([hash, [packageLocation, dependenciesLocation]]) => [hash, { packageLocation, dependenciesLocation }])),
      locatorByPath: new Map(),
    }]]) }
  }

  /** a project whose root depends on `beta`, which depends on `alpha` of the given version */
  function yarnProject(dir: string, alpha: string) {
    const packages = [
      { ...ident('project'), locatorHash: 'project', reference: 'workspace:.', version: '0.0.0', linkType: 'SOFT', deps: ['beta'] },
      { ...ident('beta'), locatorHash: 'beta', reference: 'npm:1.0.0', version: '1.0.0', linkType: 'HARD', deps: [`alpha-${alpha}`] },
      { ...ident('alpha'), locatorHash: `alpha-${alpha}`, reference: `npm:${alpha}`, version: alpha, linkType: 'HARD', deps: [] },
    ]
    const state = {
      ...customData(new Map(packages.map(({ locatorHash, linkType }) => [locatorHash, linkType === 'SOFT'
        ? [dir, join(dir, 'node_modules')]
        : store(dir, locatorHash)]))),
      accessibleLocators: new Set(packages.map(pkg => pkg.locatorHash)),
      storedResolutions: new Map(packages.map(pkg => [`descriptor-${pkg.locatorHash}`, pkg.locatorHash])),
      storedPackages: new Map(packages.map(({ deps, ...pkg }) => [pkg.locatorHash, {
        ...pkg,
        dependencies: new Map(deps.map(hash => [`ident-${hash.split('-')[0]}`, { ...ident(hash.split('-')[0]), descriptorHash: `descriptor-${hash}` }])),
      }])),
    }
    mkdirSync(join(dir, '.yarn'), { recursive: true })
    writeFileSync(join(dir, '.yarn/install-state.gz'), gzipSync(serialize(state)))
  }

  it('updates a dependency whose link between packages is retargeted', async () => {
    // yarn records the real paths
    mkdirSync(join(temp, `project-${++counter}`), { recursive: true })
    const dir = realpathSync(join(temp, `project-${counter}`))
    const readState = () => readYarnBerryIsolatedState(dir, join(dir, '.yarn/install-state.gz'))
    yarnProject(dir, '1.0.0')
    const before = await readState()
    yarnProject(dir, '1.1.0')
    const after = await readState()
    const beta = store(dir, 'beta')[0]
    const location = toPosix(relative(dir, join(beta, format === 'yarn 3' ? 'node_modules/alpha' : '../node_modules/alpha')))
    const diff = diffState(dir, before, after)
    expect(diff.updated.map(change => change.path)).to.deep.equal([join(dir, location)])
    expect(diff.updated[0].before).to.include({ version: '1.0.0', realPath: store(dir, 'alpha-1.0.0')[0] })
    expect(diff.updated[0].after).to.include({ version: '1.1.0', realPath: store(dir, 'alpha-1.1.0')[0] })
    expect(after.get('node_modules/beta')).to.include({ version: '1.0.0', realPath: beta })
  })
})

describe('yarn berry install state', () => {
  it('rejects an install state without the data of a supported pnpm linker', async () => {
    const dir = createProject({})
    mkdirSync(join(dir, '.yarn'), { recursive: true })
    const data = { installersCustomData: new Map([[JSON.stringify({ name: 'PnpmInstaller', version: 1 }), {}]]) }
    writeFileSync(join(dir, '.yarn/install-state.gz'), gzipSync(serialize(data)))
    await expect(readYarnBerryIsolatedState(dir, join(dir, '.yarn/install-state.gz'))).rejects.toThrow('PnpmInstaller')
  })

  it('resolves the real directory of a local dependency and its dependencies through a symlink', async () => {
    mkdirSync(join(temp, `project-${++counter}/real`), { recursive: true })
    const dir = realpathSync(join(temp, `project-${counter}`))
    writeFileSync(join(dir, 'real/package.json'), JSON.stringify({ name: 'portaled', version: '1.0.0' }))
    symlinkSync(join(dir, 'real'), join(dir, 'aliased'), 'junction')
    const store = join(dir, 'node_modules/.store/alpha-npm-1.0.0/package')
    const ident = (name: string) => ({ identHash: `ident-${name}`, scope: null, name })
    const packages = [
      { ...ident('project'), locatorHash: 'project', reference: 'workspace:.', version: '0.0.0', linkType: 'SOFT', dependencies: new Map([['ident-loc', { ...ident('loc'), descriptorHash: 'descriptor-loc' }]]) },
      // a portal whose location is a symlink to the real directory, with its own dependency
      { ...ident('loc'), locatorHash: 'loc', reference: 'portal:./aliased', version: null, linkType: 'SOFT', dependencies: new Map([['ident-alpha', { ...ident('alpha'), descriptorHash: 'descriptor-alpha' }]]) },
      { ...ident('alpha'), locatorHash: 'alpha', reference: 'npm:1.0.0', version: '1.0.0', linkType: 'HARD', dependencies: new Map() },
    ]
    const data = {
      linkersCustomData: new Map([[JSON.stringify({ name: 'PnpmLinker', version: 3 }), {
        pathsByLocator: new Map([
          ['project', { packageLocation: dir, dependenciesLocation: join(dir, 'node_modules') }],
          ['loc', { packageLocation: join(dir, 'aliased'), dependenciesLocation: join(dir, 'aliased/node_modules') }],
          ['alpha', { packageLocation: store, dependenciesLocation: join(store, '../node_modules') }],
        ]),
        locatorByPath: new Map(),
      }]]),
      accessibleLocators: new Set(['project', 'loc', 'alpha']),
      storedResolutions: new Map([['descriptor-loc', 'loc'], ['descriptor-alpha', 'alpha']]),
      storedPackages: new Map(packages.map(pkg => [pkg.locatorHash, pkg])),
    }
    mkdirSync(join(dir, '.yarn'), { recursive: true })
    writeFileSync(join(dir, '.yarn/install-state.gz'), gzipSync(serialize(data)))
    const state = await readYarnBerryIsolatedState(dir, join(dir, '.yarn/install-state.gz'))
    expect(state.get('node_modules/loc')).to.include({ name: 'portaled', local: true, realPath: realpathSync(join(dir, 'real')) })
    // the dependency of the portal is resolved through the real directory, as Node does
    expect(state.get('real/node_modules/alpha')).to.include({ name: 'alpha', version: '1.0.0', realPath: store })
    expect(state.has('aliased/node_modules/alpha')).to.equal(false)
  })
})

describe('diffState', () => {
  it('updates a package whose real directory changed', () => {
    const state = (realPath: string): PackageState => ({ name: 'alpha', version: '1.0.0', resolution: 'sha512-a', local: false, realPath })
    const before: InstallState = new Map([['node_modules/alpha', state('/shared/alpha')]])
    const after: InstallState = new Map([['node_modules/alpha', state('/project/node_modules/alpha')]])
    expect(diffState('/project', before, after).updated.map(change => change.name)).to.deep.equal(['alpha'])
  })
})
