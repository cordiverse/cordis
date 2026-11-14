import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Env, run, which } from './process.ts'
import { readNpmState } from './readers/npm.ts'
import { PNPM_ISOLATED_VERSIONS, readPnpmHoistedState, readPnpmIsolatedState } from './readers/pnpm.ts'
import { readYarnBerryHoistedState, readYarnBerryIsolatedState, YARN_PNPM_LINKER_VERSIONS } from './readers/yarn-berry.ts'
import { readYarnClassicState } from './readers/yarn-classic.ts'
import { InstallState } from './state.ts'
import { isInRange } from './version.ts'

export type AgentName = 'npm' | 'pnpm' | 'yarn'
export type AgentKind = 'npm' | 'pnpm' | 'yarn-classic' | 'yarn-berry'
/**
 * The layout of `node_modules`. A hoisted layout installs packages in place,
 * while an isolated layout installs a registry package in a store entry and
 * links it into the `node_modules` folders from which it is resolved. A `link:`,
 * `portal:` or workspace package resolves to its own directory either way.
 */
export type AgentLayout = 'hoisted' | 'isolated'

export interface AgentInfo {
  kind: AgentKind
  name: AgentName
  spec: string
  version: string
  executable: string
  layout: AgentLayout
}

/** A detected layout and the reader of its install state. */
export interface Layout {
  name: AgentLayout
  readState(root: string): Promise<InstallState>
}

/** The capabilities of a kind of agent, independent of a project. */
export interface Adapter {
  installArgs: string[]
  recoverArgs: string[]
  /**
   * The lockfiles of the project root, one of which must exist. They are
   * restored after a failed installation, as is `package.json`.
   */
  lockfiles: string[]
  /** other files restored after a failed installation, as paths relative to the project root */
  restoredFiles: string[]
  /** Detect the layout, and reject an unsupported one before the project is modified. */
  detectLayout(info: Omit<AgentInfo, 'layout'>, root: string, env: Env, manifest: any): Promise<Layout>
}

type PartialInfo = Omit<AgentInfo, 'layout'>

/** The agent of a project with its detected layout. */
export interface Agent {
  info: AgentInfo
  adapter: Adapter
  readState(): Promise<InstallState>
}

async function getConfig(info: PartialInfo, root: string, env: Env, key: string) {
  const { stdout } = await run(info.executable, ['config', 'get', key], { cwd: root, env, timeout: 60000 })
  return stdout.trim().split(/\r?\n/).pop()?.trim()
}

/** Select the option of a configured value, and reject a value without an option. */
function selectOption<T>(info: PartialInfo, key: string, value: string | undefined, options: Record<string, T>): T {
  if (Object.hasOwn(options, value!)) return options[value!]
  const expected = Object.keys(options).map(name => `"${name}"`).join(' or ')
  throw new Error(`${info.spec} is configured with ${key} "${value}", only ${expected} is supported`)
}

async function getYarnClassicLayout(info: PartialInfo, root: string, env: Env, manifest: any) {
  const { stdout } = await run(info.executable, ['config', 'list', '--json'], { cwd: root, env, timeout: 60000 })
  // the yarn configuration, then the npm configuration
  const [yarnrc = {}, npmrc = {}] = stdout.split(/\r?\n/).flatMap((line) => {
    try {
      const data = JSON.parse(line)
      return data?.type === 'inspect' ? [data.data ?? {}] : []
    } catch {
      return []
    }
  })
  const option = (name: string) => yarnrc[name] ?? npmrc[name]
  // a boolean flag is passed only if it is `true`
  const flag = (name: string) => yarnrc[`--${name}`] === true || yarnrc[`--install.${name}`] === true

  // `plugnplay-override` enables Plug'n'Play unless it is the string `false`
  // or `0`; the flags follow, then the manifest.
  let pnp: boolean
  const override = option('plugnplay-override')
  if (override != null) {
    pnp = override !== 'false' && override !== '0'
  } else if (flag('pnp') || flag('enable-pnp') || flag('disable-pnp')) {
    pnp = flag('pnp') || flag('enable-pnp')
  } else {
    pnp = !!manifest?.installConfig?.pnp
  }
  return {
    pnp,
    // the flags for `install` follow those for every command, so that they take precedence
    modulesFolder: (yarnrc['--install.modules-folder'] ?? yarnrc['--modules-folder']) as string | undefined,
    // yarn converts the option with `Boolean()`, so that the string `false` enables it
    metaFolder: Boolean(option('enable-meta-folder')),
  }
}

export const adapters: Record<AgentKind, Adapter> = {
  'npm': {
    installArgs: ['install', '--no-audit', '--no-fund'],
    // `npm ci` would remove `node_modules` first
    recoverArgs: ['install', '--no-audit', '--no-fund', '--prefer-offline'],
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
    restoredFiles: ['.npmrc'],
    async detectLayout(info, root, env) {
      return selectOption(info, 'install-strategy', await getConfig(info, root, env, 'install-strategy'), {
        hoisted: { name: 'hoisted', readState: readNpmState },
      })
    },
  },
  'pnpm': {
    // In CI, pnpm defaults to a frozen lockfile, and it asks before purging
    // a modules directory created with other settings. The recovery disables
    // `optimisticRepeatInstall` of pnpm 11, which skips an installation whose
    // lockfile and manifests equal those of the last successful installation,
    // as the restored files do.
    installArgs: ['install', '--no-frozen-lockfile', '--config.confirmModulesPurge=false'],
    recoverArgs: ['install', '--frozen-lockfile', '--prefer-offline', '--config.confirmModulesPurge=false', '--config.optimisticRepeatInstall=false'],
    lockfiles: ['pnpm-lock.yaml'],
    restoredFiles: ['pnpm-workspace.yaml', '.npmrc'],
    async detectLayout(info, root, env) {
      const linker = await getConfig(info, root, env, 'node-linker')
      // pnpm prints `undefined` for the default
      const layout = selectOption<AgentLayout>(info, 'node-linker', linker === 'undefined' ? 'isolated' : linker, {
        hoisted: 'hoisted',
        isolated: 'isolated',
      })
      if (layout === 'hoisted') return { name: 'hoisted', readState: readPnpmHoistedState }
      // this version writes the state after the installation
      if (!isInRange(info.version, PNPM_ISOLATED_VERSIONS)) {
        const [min, max] = PNPM_ISOLATED_VERSIONS
        throw new Error(`${info.spec} is configured with node-linker "isolated", which is only supported for pnpm >=${min} <${max}`)
      }
      if (await getConfig(info, root, env, 'enable-global-virtual-store') === 'true') {
        throw new Error(`${info.spec} is configured with enable-global-virtual-store, only a virtual store in the project is supported`)
      }
      return { name: 'isolated', readState: readPnpmIsolatedState }
    },
  },
  'yarn-classic': {
    installArgs: ['install', '--non-interactive'],
    recoverArgs: ['install', '--non-interactive', '--frozen-lockfile', '--prefer-offline'],
    lockfiles: ['yarn.lock'],
    restoredFiles: ['.yarnrc', '.npmrc'],
    async detectLayout(info, root, env, manifest) {
      const { pnp, modulesFolder, metaFolder } = await getYarnClassicLayout(info, root, env, manifest)
      if (pnp) {
        throw new Error(`${info.spec} is configured with Plug'n'Play, only node_modules is supported`)
      }
      if (modulesFolder != null) {
        throw new Error(`${info.spec} is configured with modules-folder "${modulesFolder}", only node_modules is supported`)
      }
      if (metaFolder) {
        // the install state would be written to `.yarn-meta` instead
        throw new Error(`${info.spec} is configured with enable-meta-folder, only the install state in node_modules is supported`)
      }
      return { name: 'hoisted', readState: readYarnClassicState }
    },
  },
  'yarn-berry': {
    // In CI, yarn berry defaults to immutable installations.
    installArgs: ['install', '--no-immutable'],
    recoverArgs: ['install', '--immutable'],
    lockfiles: ['yarn.lock'],
    restoredFiles: ['.yarnrc.yml', '.yarn/install-state.gz'],
    async detectLayout(info, root, env) {
      const layout = selectOption<AgentLayout>(info, 'nodeLinker', await getConfig(info, root, env, 'nodeLinker'), {
        'node-modules': 'hoisted',
        'pnpm': 'isolated',
      })
      if (layout === 'hoisted') return { name: 'hoisted', readState: readYarnBerryHoistedState }
      if (!isInRange(info.version, YARN_PNPM_LINKER_VERSIONS)) {
        const [min, max] = YARN_PNPM_LINKER_VERSIONS
        throw new Error(`${info.spec} is configured with nodeLinker "pnpm", which is only supported for yarn >=${min} <${max}`)
      }
      const installStatePath = resolve(root, await getConfig(info, root, env, 'installStatePath') || '.yarn/install-state.gz')
      return { name: 'isolated', readState: root => readYarnBerryIsolatedState(root, installStatePath) }
    },
  },
}

export async function detectAgent(root: string, env: Env): Promise<Agent> {
  const manifestPath = resolve(root, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const spec = manifest.packageManager
  if (typeof spec !== 'string') {
    throw new Error(`${manifestPath} has no "packageManager" field`)
  }
  const capture = /^(npm|pnpm|yarn)@(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(spec)
  if (!capture) {
    throw new Error(`unsupported "packageManager" field "${spec}", expected npm, pnpm or yarn with an exact version`)
  }
  const name = capture[1] as AgentName
  const major = +capture[2]

  const executable = which(name, env)
  if (!executable) throw new Error(`${name} is not found in PATH`)
  const { stdout } = await run(executable, ['--version'], { cwd: root, env, timeout: 60000 })
  const version = stdout.trim().split(/\r?\n/).pop()!.trim()
  if (+version.split('.')[0] !== major) {
    throw new Error(`${executable} reports version ${version}, which does not match "${spec}"`)
  }

  const kind: AgentKind = name !== 'yarn' ? name : major === 1 ? 'yarn-classic' : 'yarn-berry'
  const partial: PartialInfo = { kind, name, spec, version, executable }
  const adapter = adapters[kind]
  const layout = await adapter.detectLayout(partial, root, env, manifest)
  return { info: { ...partial, layout: layout.name }, adapter, readState: () => layout.readState(root) }
}
