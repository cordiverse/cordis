import { ChildProcess, fork } from 'child_process'
import { extname, resolve } from 'path'
import kleur from 'kleur'
import type * as worker from './worker/index.js'
import { fileURLToPath } from 'url'

type Event = Event.Start | Event.Env | Event.Heartbeat

namespace Event {
  export interface Start {
    type: 'start'
  }

  export interface Env {
    type: 'shared'
    body: string
  }

  export interface Heartbeat {
    type: 'heartbeat'
  }
}

let child: ChildProcess

process.env.CORDIS_SHARED = JSON.stringify({
  startTime: Date.now(),
})

function createWorker(options: worker.Options) {
  let timer: 0 | NodeJS.Timeout | undefined
  let started = false

  const filename = fileURLToPath(import.meta.url)
  child = fork(resolve(filename, `../worker/main${extname(filename)}`), [], {
    execArgv: [
      ...process.execArgv,
      ...options.daemon?.execArgv || [],
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

  // https://nodejs.org/api/process.html#signal-events
  // https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/signal
  const signals: NodeJS.Signals[] = [
    'SIGABRT',
    'SIGBREAK',
    'SIGBUS',
    'SIGFPE',
    'SIGHUP',
    'SIGILL',
    'SIGINT',
    'SIGKILL',
    'SIGSEGV',
    'SIGSTOP',
    'SIGTERM',
  ]

  function shouldExit(code: number, signal: NodeJS.Signals) {
    // start failed
    if (!started) return true

    // exit manually
    if (code === 0) return true
    if (signals.includes(signal)) return true

    // restart manually
    if (code === 51) return false
    if (code === 52) return true

    // fallback to autoRestart
    return !options.daemon?.autoRestart
  }

  child.on('exit', (code, signal) => {
    if (shouldExit(code!, signal!)) {
      process.exit(code!)
    }
    createWorker(options)
  })
}

export async function start(options: worker.Options) {
  if (options.daemon) return createWorker(options)
  const worker = await import('./worker/index.js')
  worker.start(options)
}
