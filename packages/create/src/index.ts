import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { basename, join, relative } from 'node:path'
import { Readable } from 'node:stream'
import * as tar from 'tar'
import * as yaml from 'js-yaml'
import envPaths from 'env-paths'
import getRegistry from 'get-registry'
import parse from 'yargs-parser'
import prompts from 'prompts'
import which from 'which-pm-runs'
import kleur from 'kleur'

const paths = envPaths('create-cordis', { suffix: '' })

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
  registry?: string

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
    const stats = await stat(rootDir).catch(() => null)
    if (!stats) return mkdir(rootDir, { recursive: true })

    let message: string
    if (stats.isDirectory()) {
      const files = await readdir(rootDir)
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

    await rm(rootDir, { recursive: true })
    await mkdir(rootDir)
  }

  async downloadYarn() {
    interface YarnRC {
      yarnPath?: string
    }

    const rc = yaml.load(await readFile(join(rootDir, '.yarnrc.yml'), 'utf8')) as any as YarnRC
    const version = rc.yarnPath?.match(/^\.yarn\/releases\/yarn-([^/]+).cjs$/)?.[1]
    if (!version) return

    const cacheDir = join(paths.cache, '.yarn/releases')
    const cacheFile = join(cacheDir, `yarn-${version}.cjs`)
    try {
      await access(cacheFile)
    } catch {
      const tempDir = join(paths.temp, '@yarnpkg/cli-dist')
      await mkdir(tempDir, { recursive: true })
      await mkdir(cacheDir, { recursive: true })
      const resp3 = await fetch(`${this.registry}/@yarnpkg/cli-dist/-/cli-dist-${version}.tgz`)
      await new Promise<void>((resolve, reject) => {
        const stream = Readable.fromWeb(resp3.body as any).pipe(tar.extract({
          cwd: tempDir,
          newer: true,
          strip: 2,
        }, ['package/bin/yarn.js']))
        stream.on('finish', resolve)
        stream.on('error', reject)
      })
      // https://github.com/satorijs/satori/issues/305
      await copyFile(join(tempDir, 'yarn.js'), cacheFile)
      await rm(tempDir, { recursive: true })
    }

    const targetDir = join(rootDir, '.yarn/releases')
    const targetFile = join(targetDir, `yarn-${version}.cjs`)
    await mkdir(targetDir, { recursive: true })
    await copyFile(cacheFile, targetFile)
    return version
  }

  async scaffold() {
    const registry = await getRegistry()
    if (!registry) {
      console.log(kleur.red('error') + ' unable to detect npm registry')
      process.exit(1)
    }

    this.registry = registry.replace(/\/$/, '')
    console.log(kleur.dim('  Registry server: ') + this.registry)

    console.log(kleur.dim('  Scaffolding project in ') + project + kleur.dim(' ...'))
    const template = argv.template || this.options.template

    const resp1 = await fetch(`${this.registry}/${template}`)
    if (!resp1.ok) {
      const { status, statusText } = resp1
      console.log(`${kleur.red('error')} request failed with status code ${status} ${statusText}`)
      process.exit(1)
    }
    const remote = await resp1.json()
    const version = remote['dist-tags'][argv.ref || 'latest']

    const resp2 = await fetch(remote.versions[version].dist.tarball)
    await new Promise<void>((resolve, reject) => {
      const stream = Readable.fromWeb(resp2.body as any).pipe(tar.extract({
        cwd: rootDir,
        newer: true,
        strip: 1,
      }))
      stream.on('finish', resolve)
      stream.on('error', reject)
    })

    const yarnVersion = await this.downloadYarn()
    const packageManager = yarnVersion ? `yarn@${yarnVersion}` : undefined
    await this.writePackageJson(packageManager)
    console.log(kleur.green('  Done.\n'))
  }

  async writePackageJson(packageManager?: string) {
    const filename = join(rootDir, 'package.json')
    const meta = JSON.parse(await readFile(filename, 'utf8'))
    meta.name = project
    meta.packageManager = packageManager
    if (argv.prod) {
      // https://github.com/koishijs/koishi/issues/994
      // Do not use `NODE_ENV` or `--production` flag.
      // Instead, simply remove `devDependencies` and `workspaces`.
      delete meta.workspaces
      delete meta.devDependencies
    }
    await writeFile(filename, JSON.stringify(meta, null, 2) + '\n')
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
    console.log(`  ${kleur.bold(`create ${this.options.name}`)}  ${kleur.blue(`v${this.options.version}`)}`)
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
