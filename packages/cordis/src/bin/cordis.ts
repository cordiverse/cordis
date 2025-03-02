#!/usr/bin/env node

import { cac } from 'cac'
import { start } from '../cli.ts'
import { Dict, hyphenate } from 'cosmokit'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json')

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
  .action((file, options) => {
    const { ...rest } = options
    start({
      name: 'cordis',
      filename: file || '',
      execArgv: unparse(rest),
      daemon: {},
      logger: {},
    })
  })

const argv = cli.parse()

if (!cli.matchedCommand && !argv.options.help) {
  cli.outputHelp()
}
