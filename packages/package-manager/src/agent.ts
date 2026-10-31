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
  lockfiles: string[]
  files: string[]
  checkLayout(info: AgentInfo, root: string, env: Env): Promise<void>
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

export const adapters: Record<AgentKind, Adapter> = {
  'npm': {
    installArgs: ['install', '--no-audit', '--no-fund'],
    // `npm ci` would remove `node_modules` first
    recoverArgs: ['install', '--no-audit', '--no-fund', '--prefer-offline'],
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
    files: ['.npmrc'],
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
    files: ['pnpm-workspace.yaml', '.npmrc'],
    async checkLayout(info, root, env) {
      assertLayout(info, 'node-linker', await getConfig(info, root, env, 'node-linker'), 'hoisted')
    },
    readState: readPnpmState,
  },
  'yarn-classic': {
    installArgs: ['install', '--non-interactive'],
    recoverArgs: ['install', '--non-interactive', '--frozen-lockfile', '--prefer-offline'],
    lockfiles: ['yarn.lock'],
    files: ['.yarnrc', '.npmrc'],
    // yarn classic has no other layout
    async checkLayout() {},
    readState: readYarnClassicState,
  },
  'yarn-berry': {
    // In CI, yarn berry defaults to immutable installations.
    installArgs: ['install', '--no-immutable'],
    recoverArgs: ['install', '--immutable'],
    lockfiles: ['yarn.lock'],
    files: ['.yarnrc.yml', '.yarn/install-state.gz'],
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
  await adapters[kind].checkLayout(info, root, env)
  return info
}
