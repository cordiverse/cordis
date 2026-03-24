import { ChildProcess, fork } from 'node:child_process'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import type {} from '@cordisjs/plugin-cli'
import type { Options } from './worker/index.ts'
import kleur from 'kleur'

export const name = 'cli-run'
export const inject = ['cli']

interface Event {
  type: 'start' | 'shared' | 'heartbeat'
  body?: string
}

export function apply(ctx: Context, config: Options) {
  ctx.cli.command('run [file]', 'start a cordis application')
    .option('-d, --daemon', 'run as daemon')
    .action(async (argv) => {
      const file = argv.args[0] || ''
      const options = argv.options as { daemon?: boolean }

      const workerOptions: Options = {
        filename: file,
        execArgv: [],
        ...config,
      }

      if (options.daemon) {
        workerOptions.daemon = {}
        createWorker(workerOptions)
      } else {
        // Direct mode: load in the same process
        const { start } = await import('./worker/index.ts')
        await start(workerOptions)
      }
    })
}

let child: ChildProcess

function createWorker(options: Options) {
  let timer: 0 | NodeJS.Timeout | undefined
  let started = false

  process.env.CORDIS_SHARED = JSON.stringify({
    startTime: Date.now(),
  })

  const filename = fileURLToPath(import.meta.url)
  child = fork(resolve(filename, `../worker/main${extname(filename)}`), [], {
    execArgv: [
      ...process.execArgv,
      ...options.execArgv || [],
    ],
    env: {
      ...process.env,
      CORDIS_LOADER_OPTIONS: JSON.stringify(options),
    },
  })

  child.on('message', (message: Event) => {
    if (message.type === 'start') {
      started = true
      timer = options.daemon?.heartbeatTimeout && setTimeout(() => {
        // eslint-disable-next-line no-console
        console.log(kleur.red('daemon: heartbeat timeout'))
        child.kill('SIGKILL')
      }, options.daemon?.heartbeatTimeout)
    } else if (message.type === 'shared') {
      process.env.CORDIS_SHARED = message.body
    } else if (message.type === 'heartbeat') {
      if (timer) timer.refresh()
    }
  })

  const signals: NodeJS.Signals[] = [
    'SIGABRT', 'SIGBREAK', 'SIGBUS', 'SIGFPE', 'SIGHUP',
    'SIGILL', 'SIGINT', 'SIGKILL', 'SIGSEGV', 'SIGSTOP', 'SIGTERM',
  ]

  function shouldExit(code: number, signal: NodeJS.Signals) {
    if (!started) return true
    if (code === 0) return true
    if (signals.includes(signal)) return true
    if (code === 51) return false
    if (code === 52) return true
    return !options.daemon?.autoRestart
  }

  child.on('exit', (code, signal) => {
    if (shouldExit(code!, signal!)) {
      process.exit(code!)
    }
    createWorker(options)
  })
}
