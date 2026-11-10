import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { serialize } from 'node:v8'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { readYarnBerryHoistedState, readYarnBerryIsolatedState } from '../src/readers/yarn-berry.ts'
import { diffState } from '../src/state.ts'
import { createDir, createProject, toPosix } from './utils.ts'

describe('node-modules linker', () => {
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
    const state = await readYarnBerryHoistedState(dir)
    expect(state.get('node_modules/foo')).to.include({ name: 'foo', local: true })
    expect(state.get('node_modules/bar')).to.include({ name: 'bar', version: '1.2.3', local: false })
    expect(diffState(dir, state, state).updated.map(change => change.name)).to.deep.equal(['foo'])
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
    const dir = createDir()
    const readState = () => readYarnBerryIsolatedState(dir, join(dir, '.yarn/install-state.gz'))
    yarnProject(dir, '1.0.0')
    const before = await readState()
    yarnProject(dir, '1.1.0')
    const after = await readState()
    const beta = store(dir, 'beta')[0]
    const location = toPosix(relative(dir, join(beta, format === 'yarn 3' ? 'node_modules/alpha' : '../node_modules/alpha')))
    const diff = diffState(dir, before, after)
    expect(diff.updated.map(change => change.path)).to.deep.equal([join(dir, location)])
    expect(diff.updated[0].before).to.include({ version: '1.0.0', realpath: store(dir, 'alpha-1.0.0')[0] })
    expect(diff.updated[0].after).to.include({ version: '1.1.0', realpath: store(dir, 'alpha-1.1.0')[0] })
    expect(after.get('node_modules/beta')).to.include({ version: '1.0.0', realpath: beta })
  })
})

describe('install state', () => {
  it('rejects an install state without the data of a supported pnpm linker', async () => {
    const dir = createProject({})
    mkdirSync(join(dir, '.yarn'), { recursive: true })
    const data = { installersCustomData: new Map([[JSON.stringify({ name: 'PnpmInstaller', version: 1 }), {}]]) }
    writeFileSync(join(dir, '.yarn/install-state.gz'), gzipSync(serialize(data)))
    await expect(readYarnBerryIsolatedState(dir, join(dir, '.yarn/install-state.gz'))).rejects.toThrow('PnpmInstaller')
  })

  it('resolves the real directory of a local dependency and its dependencies through a symlink', async () => {
    const dir = createDir()
    createProject({ 'real/package.json': { name: 'portaled', version: '1.0.0' } }, dir)
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
    expect(state.get('node_modules/loc')).to.include({ name: 'portaled', local: true, realpath: realpathSync(join(dir, 'real')) })
    // the dependency of the portal is resolved through the real directory, as Node does
    expect(state.get('real/node_modules/alpha')).to.include({ name: 'alpha', version: '1.0.0', realpath: store })
    expect(state.has('aliased/node_modules/alpha')).to.equal(false)
  })
})
