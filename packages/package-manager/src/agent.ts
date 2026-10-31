import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Env, run, which } from './process.ts'
import { InstallState, readYarnBerryState, readYarnClassicState, readNpmState, readPnpmState } from './state.ts'

export type AgentName = 'npm' | 'pnpm' | 'yarn'
export type AgentKind = 'npm' | 'pnpm' | 'yarn-classic' | 'yarn-berry'

export interface AgentInfo {
  kind: AgentKind
  name: AgentName
  spec: string
  version: string
  executable: string
}

export interface Adapter {
  installArgs: string[]
  recoverArgs: string[]
  /**
   * The lockfiles of the project root, one of which must exist. They are
   * restored after a failed installation, as is `package.json`.
   */
  lockfiles: string[]
  /** the other files of the project root that are restored after a failed installation */
  restoredFiles: string[]
  checkLayout(info: AgentInfo, root: string, env: Env, manifest: any): Promise<void>
  readState(root: string): Promise<InstallState>
}

async function getConfig(info: AgentInfo, root: string, env: Env, key: string) {
  const { stdout } = await run(info.executable, ['config', 'get', key], { cwd: root, env, timeout: 60000 })
  return stdout.trim().split(/\r?\n/).pop()?.trim()
}

function assertLayout(info: AgentInfo, key: string, value: string | undefined, expected: string) {
  if (value === expected) return
  throw new Error(`${info.spec} is configured with ${key} "${value}", only "${expected}" is supported`)
}

async function getYarnClassicLayout(info: AgentInfo, root: string, env: Env, manifest: any) {
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
    async checkLayout(info, root, env) {
      assertLayout(info, 'install-strategy', await getConfig(info, root, env, 'install-strategy'), 'hoisted')
    },
    readState: readNpmState,
  },
  'pnpm': {
    // In CI, pnpm defaults to a frozen lockfile, and it asks before purging
    // a modules directory created with other settings.
    installArgs: ['install', '--no-frozen-lockfile', '--config.confirmModulesPurge=false'],
    recoverArgs: ['install', '--frozen-lockfile', '--prefer-offline', '--config.confirmModulesPurge=false'],
    lockfiles: ['pnpm-lock.yaml'],
    restoredFiles: ['pnpm-workspace.yaml', '.npmrc'],
    async checkLayout(info, root, env) {
      assertLayout(info, 'node-linker', await getConfig(info, root, env, 'node-linker'), 'hoisted')
    },
    readState: readPnpmState,
  },
  'yarn-classic': {
    installArgs: ['install', '--non-interactive'],
    recoverArgs: ['install', '--non-interactive', '--frozen-lockfile', '--prefer-offline'],
    lockfiles: ['yarn.lock'],
    restoredFiles: ['.yarnrc', '.npmrc'],
    async checkLayout(info, root, env, manifest) {
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
    },
    readState: readYarnClassicState,
  },
  'yarn-berry': {
    // In CI, yarn berry defaults to immutable installations.
    installArgs: ['install', '--no-immutable'],
    recoverArgs: ['install', '--immutable'],
    lockfiles: ['yarn.lock'],
    restoredFiles: ['.yarnrc.yml', '.yarn/install-state.gz'],
    async checkLayout(info, root, env) {
      assertLayout(info, 'nodeLinker', await getConfig(info, root, env, 'nodeLinker'), 'node-modules')
    },
    readState: readYarnBerryState,
  },
}

export async function detectAgent(root: string, env: Env): Promise<AgentInfo> {
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
  const info: AgentInfo = { kind, name, spec, version, executable }
  await adapters[kind].checkLayout(info, root, env, manifest)
  return info
}
