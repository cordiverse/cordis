import { ChildProcess, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export type Env = Record<string, string | undefined>

function getPathKey(env: Env) {
  if (process.platform !== 'win32') return 'PATH'
  return Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'Path'
}

function isBerryBin(dir: string) {
  if (!/^xfs-[0-9a-f]+$/.test(basename(dir))) return false
  return ['yarn', 'node'].every(name => existsSync(join(dir, name)) || existsSync(join(dir, `${name}.cmd`)))
}

export function createEnv(base: Env = process.env): Env {
  const env: Env = { ...base }
  for (const key of Object.keys(env)) {
    if (/^npm_(package_|lifecycle_|config_user_agent$|execpath$|node_execpath$|command$)/.test(key)) {
      delete env[key]
    }
  }
  const berryBin = env.BERRY_BIN_FOLDER
  for (const key of ['BERRY_BIN_FOLDER', 'PROJECT_CWD', 'INIT_CWD']) {
    delete env[key]
  }
  const pathKey = getPathKey(env)
  env[pathKey] = env[pathKey]
    ?.split(delimiter)
    .filter(dir => dir !== berryBin && !isBerryBin(dir))
    .join(delimiter)
  // Corepack would otherwise wait for a confirmation to download the declared version.
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  return env
}

function isExecutable(file: string) {
  try {
    if (!statSync(file).isFile()) return false
    if (process.platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function which(command: string, env: Env) {
  const dirs = env[getPathKey(env)]?.split(delimiter) ?? []
  const exts = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const file = join(dir, command + ext)
      if (isExecutable(file)) return file
    }
  }
}

export interface RunOptions {
  cwd: string
  env: Env
  signal?: AbortSignal
  timeout?: number
  /** The maximum number of characters retained of the combined output. */
  limit?: number
  onOutput?: (chunk: string) => void
}

export interface RunResult {
  stdout: string
  /** the tail of stdout and stderr in the order of arrival */
  output: string
}

export class RunError extends Error {
  constructor(message: string, public output: string, public code?: number | null) {
    super(message)
    this.name = 'RunError'
  }
}

/** The interval between SIGTERM and SIGKILL, in milliseconds. */
const KILL_DELAY = 5000

function hasGroup(pid: number) {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

async function killTree(child: ChildProcess) {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        .on('close', () => resolve())
        .on('error', () => resolve())
    })
    return
  }
  try {
    // the child leads its own process group, see `detached` below
    process.kill(-pid, 'SIGTERM')
  } catch {
    return
  }
  const start = Date.now()
  let killed = false
  while (hasGroup(pid)) {
    const elapsed = Date.now() - start
    if (elapsed >= 2 * KILL_DELAY) return
    if (!killed && elapsed >= KILL_DELAY) {
      killed = true
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
    }
    await sleep(100)
  }
}

export function run(file: string, args: string[], options: RunOptions): Promise<RunResult> {
  const { cwd, env, signal, timeout, limit = 65536, onOutput } = options
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
  return new Promise<RunResult>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const child = spawn(shell ? `"${file}"` : file, args, {
      cwd,
      env,
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // a process group, so that the whole tree can be terminated
      detached: process.platform !== 'win32',
    })

    let stdout = ''
    let output = ''
    let failure: unknown
    let killing: Promise<void> | undefined
    let timer: NodeJS.Timeout | undefined
    const terminate = (reason: unknown) => {
      failure ??= reason
      killing ??= killTree(child)
    }
    const refresh = () => {
      if (!timeout) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        terminate(new RunError(`${file} produced no output for ${timeout}ms`, output))
      }, timeout)
    }
    const onAbort = () => terminate(signal!.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    refresh()

    const append = (chunk: string) => {
      output = (output + chunk).slice(-limit)
      onOutput?.(chunk)
      refresh()
    }
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-limit)
      append(chunk)
    })
    child.stderr!.setEncoding('utf8').on('data', append)

    child.on('error', (error) => {
      failure ??= error
      // a process that could not be spawned emits no `close`
      if (child.pid === undefined) {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(failure)
      }
    })
    child.on('close', async (code, signalName) => {
      clearTimeout(timer)
      // cancellation is possible only until the agent exits
      signal?.removeEventListener('abort', onAbort)
      if (failure) {
        // a terminated run settles after the whole tree, not only the agent
        await killing
        return reject(failure)
      }
      if (code === 0) return resolve({ stdout, output })
      const status = code === null ? `signal ${signalName}` : `code ${code}`
      reject(new RunError(`${file} ${args.join(' ')} exited with ${status}\n${output}`, output, code))
    })
  })
}
