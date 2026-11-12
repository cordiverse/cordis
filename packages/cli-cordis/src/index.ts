import { ChildProcess, fork } from 'node:child_process'
import { extname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import type {} from '@cordisjs/cli'
import type { Config } from './worker/index.ts'
import kleur from 'kleur'

export const name = 'cli-cordis'
export const inject = ['cli']

interface Event {
  type: 'start' | 'shared' | 'heartbeat' | 'exit'
  body?: string
}

export function apply(ctx: Context, config: Config) {
  ctx.cli
    .command('', 'Meta-framework of spatiotemporal composability')
    .option('-v, --version', 'Show version')
    .action(({ options }) => {
      if (options.version) {
        const require = createRequire(import.meta.url)
        const { version } = require('cordis/package.json')
        return `cordis ${version}`
      }
    })

  ctx.cli
    .command('run [url]', 'Start a Cordis application')
    .option('-d, --daemon', 'Run as daemon', { default: config.daemon.enabled })
    .action(async ({ args, options }) => {
      const workerConfig: Config = { ...config }
      workerConfig.baseUrl ??= ctx.baseUrl
      if (args[0]) {
        workerConfig.path = args[0]
      }

      if (options.daemon) {
        createWorker(workerConfig)
      } else {
        // Direct mode: load in the same process
        const { start } = await import('./worker/index.ts')
        await start(workerConfig)
      }
    })
}

let child: ChildProcess

function createWorker(config: Config) {
  let timer: 0 | NodeJS.Timeout | undefined
  let started = false
  let exiting = false

  process.env.CORDIS_SHARED = JSON.stringify({
    startTime: Date.now(),
  })

  const filename = fileURLToPath(import.meta.url)
  child = fork(resolve(filename, `../worker/main${extname(filename)}`), [], {
    execArgv: [
      ...process.execArgv,
      ...config.execArgv || [],
      '--expose-internals',
    ],
    env: {
      ...process.env,
      CORDIS_LOADER_OPTIONS: JSON.stringify(config),
    },
  })

  child.on('message', (message: Event) => {
    if (message.type === 'start') {
      started = true
      timer = config.daemon?.heartbeatTimeout && setTimeout(() => {
        // eslint-disable-next-line no-console
        console.log(kleur.red('daemon: heartbeat timeout'))
        child.kill('SIGKILL')
      }, config.daemon?.heartbeatTimeout)
    } else if (message.type === 'shared') {
      process.env.CORDIS_SHARED = message.body
    } else if (message.type === 'heartbeat') {
      if (timer) timer.refresh()
    } else if (message.type === 'exit') {
      exiting = true
    }
  })

  const signals: NodeJS.Signals[] = [
    'SIGABRT', 'SIGBREAK', 'SIGBUS', 'SIGFPE', 'SIGHUP',
    'SIGILL', 'SIGINT', 'SIGKILL', 'SIGSEGV', 'SIGSTOP', 'SIGTERM',
  ]

  function shouldExit(code: number, signal: NodeJS.Signals) {
    if (!started) return true
    if (exiting) return true
    if (code === 0) return true
    if (signals.includes(signal)) return true
    if (code === 51) return false
    if (code === 52) return true
    return !config.daemon?.autoRestart
  }

  child.on('exit', (code, signal) => {
    if (shouldExit(code!, signal!)) {
      process.exit(code!)
    }
    createWorker(config)
  })
}
