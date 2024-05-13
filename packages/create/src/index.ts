import { execSync } from 'node:child_process'
import { basename, join, relative } from 'node:path'
import { extract } from 'tar'
import getRegistry from 'get-registry'
import parse from 'yargs-parser'
import prompts from 'prompts'
import which from 'which-pm-runs'
import kleur from 'kleur'
import * as fs from 'node:fs/promises'
import { Readable } from 'node:stream'

let project: string
let rootDir: string

const cwd = process.cwd()
const argv = parse(process.argv.slice(2), {
  alias: {
    ref: ['r'],
    forced: ['f'],
    git: ['g'],
    mirror: ['m'],
    prod: ['p'],
    template: ['t'],
    yes: ['y'],
  },
})

function supports(command: string) {
  try {
    execSync(command, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function confirm(message: string) {
  const { yes } = await prompts({
    type: 'confirm',
    name: 'yes',
    initial: 'Y',
    message,
  })
  return yes as boolean
}

class Scaffold {
  constructor(public options: Record<string, any> = {}) {}

  async getName() {
    if (argv._[0]) return '' + argv._[0]
    const { name } = await prompts({
      type: 'text',
      name: 'name',
      message: 'Project name:',
      initial: `${this.options.name}-app`,
    })
    return name.trim() as string
  }

  async prepare() {
    const stats = await fs.stat(rootDir).catch(() => null)
    if (!stats) return fs.mkdir(rootDir, { recursive: true })

    let message: string
    if (stats.isDirectory()) {
      const files = await fs.readdir(rootDir)
      if (!files.length) return
      message = `  Target directory "${project}" is not empty.`
    } else {
      message = `  Target "${project}" is not a directory.`
    }

    if (!argv.forced && !argv.yes) {
      console.log(kleur.yellow(message))
      const yes = await confirm('Remove existing files and continue?')
      if (!yes) process.exit(0)
    }

    await fs.rm(rootDir, { recursive: true })
    await fs.mkdir(rootDir)
  }

  async scaffold() {
    console.log(kleur.dim('  Scaffolding project in ') + project + kleur.dim(' ...'))

    const registry = (await getRegistry()).replace(/\/$/, '')
    const template = argv.template || this.options.template

    const resp1 = await fetch(`${registry}/${template}`)
    if (!resp1.ok) {
      const { status, statusText } = resp1
      console.log(`${kleur.red('error')} request failed with status code ${status} ${statusText}`)
      process.exit(1)
    }
    const remote = await resp1.json()
    const version = remote['dist-tags'][argv.ref || 'latest']

    const resp2 = await fetch(remote.versions[version].dist.tarball)
    await new Promise<void>((resolve, reject) => {
      const stream = Readable.fromWeb(resp2.body as any).pipe(extract({ cwd: rootDir, newer: true, strip: 1 }))
      stream.on('finish', resolve)
      stream.on('error', reject)
    })

    await this.writePackageJson()
    console.log(kleur.green('  Done.\n'))
  }

  async writePackageJson() {
    const filename = join(rootDir, 'package.json')
    const meta = require(filename)
    meta.name = project
    meta.private = true
    meta.version = '0.0.0'
    if (argv.prod) {
      // https://github.com/koishijs/koishi/issues/994
      // Do not use `NODE_ENV` or `--production` flag.
      // Instead, simply remove `devDependencies` and `workspaces`.
      delete meta.workspaces
      delete meta.devDependencies
    }
    await fs.writeFile(filename, JSON.stringify(meta, null, 2) + '\n')
  }

  async initGit() {
    if (!argv.git || !supports('git --version')) return
    execSync('git init', { stdio: 'ignore', cwd: rootDir })
    console.log(kleur.green('  Done.\n'))
  }

  async install() {
    // with `-y` option, we don't install dependencies
    if (argv.yes) return

    const agent = which()?.name || 'npm'
    const yes = await confirm('Install and start it now?')
    if (yes) {
      execSync([agent, 'install'].join(' '), { stdio: 'inherit', cwd: rootDir })
      execSync([agent, 'run', 'start'].join(' '), { stdio: 'inherit', cwd: rootDir })
    } else {
      console.log(kleur.dim('  You can start it later by:\n'))
      if (rootDir !== cwd) {
        const related = relative(cwd, rootDir)
        console.log(kleur.blue(`  cd ${kleur.bold(related)}`))
      }
      console.log(kleur.blue(`  ${agent === 'yarn' ? 'yarn' : `${agent} install`}`))
      console.log(kleur.blue(`  ${agent === 'yarn' ? 'yarn start' : `${agent} run start`}`))
      console.log()
    }
  }

  async start() {
    console.log()
    console.log(`  ${kleur.bold('create cordis')}  ${kleur.blue(`v${this.options.version}`)}`)
    console.log()

    const name = await this.getName()
    rootDir = join(cwd, name)
    project = basename(rootDir)

    await this.prepare()
    await this.scaffold()
    await this.initGit()
    await this.install()
  }
}

export default function scaffold(options: Record<string, any> = {}) {
  return new Scaffold(options).start()
}
