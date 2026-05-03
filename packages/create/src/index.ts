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

export interface YarnRc {
  yarnPath?: string
  [key: string]: any
}

export interface StageYarnAgent {
  name: string
  version?: string
}

export interface StageYarnOptions {
  rootDir: string
  registry: string
  agent: StageYarnAgent | undefined
  cacheDir?: string
  tempDir?: string
  fetcher?: typeof fetch
}

/**
 * Set up a yarn binary in `rootDir` per the following spec. Returns the version
 * staged (or already present), or `undefined` if nothing was done.
 *
 * 1. `package.json` has `packageManager` → no-op (the template opted into a
 *    specific toolchain; respect it).
 * 2. Caller isn't yarn (or is unknown) → no-op.
 * 3. Caller is yarn AND `.yarnrc.yml` pins a recognizable `yarnPath`
 *    (`.yarn/releases/yarn-<v>.cjs`):
 *      - Pinned binary already on disk → no-op.
 *      - Binary missing → fetch exactly that version and stage it.
 * 4. Caller is yarn 1.x AND no yarnPath is declared → fetch
 *    `@yarnpkg/cli-dist` at dist-tag `latest`, inject yarnPath into the rc,
 *    stage the binary. This is the path that lets a global yarn 1 delegate
 *    to a modern yarn on a template that didn't declare one.
 * 5. Any other yarn case (2+/3+/4+ without yarnPath, or yarnPath with a
 *    non-standard path) → no-op.
 */
export async function stageYarnBin(options: StageYarnOptions): Promise<string | undefined> {
  const { rootDir: dir, registry, agent, fetcher = fetch } = options
  const cacheDir = options.cacheDir ?? join(paths.cache, '.yarn/releases')
  const tempDir = options.tempDir ?? join(paths.temp, '@yarnpkg/cli-dist')

  let pkg: any
  try {
    pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  // Rule 1.
  if (pkg.packageManager) return undefined
  // Rule 2.
  if (agent?.name !== 'yarn') return undefined

  const rcPath = join(dir, '.yarnrc.yml')
  let rc: YarnRc = {}
  try {
    const loaded = yaml.load(await readFile(rcPath, 'utf8'))
    if (loaded && typeof loaded === 'object') rc = loaded as YarnRc
  } catch {}

  const pinned = rc.yarnPath?.match(/^\.yarn\/releases\/yarn-([^/]+)\.cjs$/)?.[1]
  let version: string
  let writeRc = false

  if (rc.yarnPath) {
    // Rule 3. Non-standard yarnPath — we can't know which cli-dist version to
    // fetch, so stay hands off.
    if (!pinned) return undefined
    const targetFile = join(dir, rc.yarnPath)
    try {
      await access(targetFile)
      return pinned
    } catch {
      version = pinned
    }
  } else {
    // Rule 4 vs 5. Only yarn 1.x without yarnPath triggers auto-latest.
    if (!agent.version?.startsWith('1.')) return undefined
    const resp = await fetcher(`${registry}/@yarnpkg/cli-dist`)
    if (!resp.ok) return undefined
    const meta = await resp.json() as any
    version = meta?.['dist-tags']?.latest
    if (!version) return undefined
    rc.yarnPath = `.yarn/releases/yarn-${version}.cjs`
    writeRc = true
  }

  // Shared cache so we don't redownload across scaffolds.
  const cacheFile = join(cacheDir, `yarn-${version}.cjs`)
  try {
    await access(cacheFile)
  } catch {
    await mkdir(tempDir, { recursive: true })
    await mkdir(cacheDir, { recursive: true })
    const resp = await fetcher(`${registry}/@yarnpkg/cli-dist/-/cli-dist-${version}.tgz`)
    await new Promise<void>((resolve, reject) => {
      const stream = Readable.fromWeb(resp.body as any).pipe(tar.extract({
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

  const targetDir = join(dir, '.yarn/releases')
  await mkdir(targetDir, { recursive: true })
  await copyFile(cacheFile, join(targetDir, `yarn-${version}.cjs`))

  if (writeRc) {
    await writeFile(rcPath, yaml.dump(rc))
  }
  return version
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

    await stageYarnBin({ rootDir, registry: this.registry, agent: which() })
    await this.writePackageJson()
    console.log(kleur.green('  Done.\n'))
  }

  async writePackageJson() {
    const filename = join(rootDir, 'package.json')
    const meta = JSON.parse(await readFile(filename, 'utf8'))
    meta.name = project
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
