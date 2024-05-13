#!/usr/bin/env node

import { cac } from 'cac'
import kleur from 'kleur'
import { start } from '../cli.js'
import { Dict, hyphenate } from 'cosmokit'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json')

function isInteger(source: any) {
  return typeof source === 'number' && Math.floor(source) === source
}

const cli = cac('cordis').help().version(version)

function toArg(key: string) {
  return key.length === 1 ? `-${key}` : `--${hyphenate(key)}`
}

function addToArray(args: string[], arg: string) {
  if (!args.includes(arg)) args.push(arg)
}

function unparse(argv: Dict) {
  const execArgv = Object.entries(argv).flatMap<string>(([key, value]) => {
    if (key === '--') return []
    key = toArg(key)
    if (value === true) {
      return [key]
    } else if (value === false) {
      return ['--no-' + key.slice(2)]
    } else if (Array.isArray(value)) {
      return value.flatMap(value => [key, value])
    } else {
      return [key, value]
    }
  })
  execArgv.push(...argv['--'])
  addToArray(execArgv, '--expose-internals')
  return execArgv
}

cli.command('start [file]', 'start a cordis application')
  .alias('run')
  .allowUnknownOptions()
  .option('--debug [namespace]', 'specify debug namespace')
  .option('--log-level [level]', 'specify log level (default: 2)')
  .option('--log-time [format]', 'show timestamp in logs')
  .action((file, options) => {
    const { logLevel, debug, logTime, ...rest } = options
    if (logLevel !== undefined && (!isInteger(logLevel) || logLevel < 0)) {
      // eslint-disable-next-line no-console
      console.warn(`${kleur.red('error')} log level should be a positive integer.`)
      process.exit(1)
    }
    process.env.CORDIS_LOG_LEVEL = logLevel || ''
    process.env.CORDIS_LOG_DEBUG = debug || ''
    process.env.CORDIS_LOADER_ENTRY = file || ''
    start({
      name: 'cordis',
      daemon: {
        execArgv: unparse(rest),
      },
      logger: {
        showTime: logTime,
      },
    })
  })

const argv = cli.parse()

if (!cli.matchedCommand && !argv.options.help) {
  cli.outputHelp()
}
