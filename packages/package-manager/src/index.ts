import { Context, Service } from 'cordis'
import { existsSync } from 'node:fs'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from 'schemastery'
import { adapters, AgentInfo, detectAgent } from './agent.ts'
import { applyChanges, DependencyChanges, normalizeChanges, stringifyManifest } from './manifest.ts'
import { createEnv, run } from './process.ts'
import { FileBackup } from './backup.ts'
import { diffState, StateDiff } from './state.ts'

export * from './agent.ts'
export * from './manifest.ts'
export * from './process.ts'
export * from './state.ts'

declare module 'cordis' {
  interface Context {
    packageManager: PackageManager
  }
}

function findRoot(dir: string) {
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

class PackageManager extends Service {
  public root?: string

  private _queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, public config: PackageManager.Config) {
    super(ctx, 'packageManager')
    const base = config.base
      ? isAbsolute(config.base) ? config.base : resolve(ctx.baseUrl ? fileURLToPath(new URL('.', ctx.baseUrl)) : '.', config.base)
      : ctx.baseUrl ? fileURLToPath(new URL('.', ctx.baseUrl)) : resolve('.')
    this.root = findRoot(base)
  }

  private _getRoot() {
    if (!this.root) throw new Error('no package.json is found for the project')
    return this.root
  }

  agent(): Promise<AgentInfo> {
    return detectAgent(this._getRoot(), createEnv())
  }

  install(changes: DependencyChanges | [string, string | null][], options: PackageManager.InstallOptions = {}) {
    const entries = normalizeChanges(changes)
    const task = this._queue.then(() => this._install(entries, options))
    this._queue = task.catch(() => {})
    return task
  }

  private async _install(changes: [string, string | null][], options: PackageManager.InstallOptions): Promise<PackageManager.InstallResult> {
    options.signal?.throwIfAborted()
    const root = this._getRoot()
    const env = createEnv()
    const agent = await detectAgent(root, env)
    const adapter = adapters[agent.kind]
    if (!adapter.lockfiles.some(file => existsSync(resolve(root, file)))) {
      throw new Error(`${root} has no lockfile, expected ${adapter.lockfiles.join(' or ')}`)
    }

    const manifestPath = resolve(root, 'package.json')
    const original = await readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(original)
    const before = await adapter.readState(root)
    const backup = await FileBackup.create(['package.json', ...adapter.lockfiles, ...adapter.files].map(file => resolve(root, file)))
    options.signal?.throwIfAborted()

    const runOptions = {
      cwd: root,
      env,
      timeout: this.config.timeout,
      onOutput: (chunk: string) => this.ctx.logger.debug(chunk.trimEnd()),
    }
    try {
      await writeFile(manifestPath, stringifyManifest(applyChanges(manifest, changes), original))
      await run(agent.executable, adapter.installArgs, { ...runOptions, signal: options.signal })
      return { agent, ...diffState(await realpath(root), before, await adapter.readState(root)) }
    } catch (error) {
      try {
        await backup.restore()
        // not cancellable, since it restores the state before the call
        await run(agent.executable, adapter.recoverArgs, runOptions)
      } catch (recoverError) {
        throw new AggregateError([error, recoverError], 'installation failed, and node_modules could not be restored from the lockfile')
      }
      throw error
    }
  }
}

namespace PackageManager {
  export interface Config {
    base?: string
    timeout: number
  }

  export const Config: z<Config> = z.object({
    base: z.string().description('The directory to look for the project from. Defaults to `ctx.baseUrl`.'),
    timeout: z.natural().role('ms').default(600000).description('Terminate the agent after it produces no output for this long, in milliseconds.'),
  })

  export interface InstallOptions {
    signal?: AbortSignal
  }

  export interface InstallResult extends StateDiff {
    agent: AgentInfo
  }
}

export default PackageManager
