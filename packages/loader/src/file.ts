import { Context } from '@cordisjs/core'
import { dirname, extname, resolve } from 'node:path'
import { access, constants, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { Entry } from './entry.ts'
import { EntryGroup } from './group.ts'
import { Loader } from './shared.ts'

export class LoaderFile {
  public url: string
  public suspend = false
  public mutable = false

  private _writeTask?: NodeJS.Timeout

  constructor(public ctx: Context, public name: string, public type?: string) {
    this.url = pathToFileURL(name).href
  }

  async checkAccess() {
    if (!this.type) return
    try {
      await access(this.name, constants.W_OK)
      this.mutable = true
    } catch {}
  }

  async read(): Promise<Entry.Options[]> {
    if (this.type === 'application/yaml') {
      return yaml.load(await readFile(this.name, 'utf8')) as any
    } else if (this.type === 'application/json') {
      // we do not use require / import here because it will pollute cache
      return JSON.parse(await readFile(this.name, 'utf8')) as any
    } else {
      const module = await import(this.name)
      return module.default || module
    }
  }

  private async _write(config: Entry.Options[]) {
    this.suspend = true
    if (!this.mutable) {
      throw new Error(`cannot overwrite readonly config`)
    }
    if (this.type === 'application/yaml') {
      await writeFile(this.name, yaml.dump(config))
    } else if (this.type === 'application/json') {
      await writeFile(this.name, JSON.stringify(config, null, 2))
    }
  }

  write(config: Entry.Options[]) {
    this.ctx.emit('config')
    clearTimeout(this._writeTask)
    this._writeTask = setTimeout(() => {
      this._writeTask = undefined
      this._write(config)
    }, 0)
  }

  async import(name: string) {
    if (this.ctx.loader.internal) {
      return this.ctx.loader.internal.import(name, this.url, {})
    } else {
      return import(name)
    }
  }

  dispose() {
    clearTimeout(this._writeTask)
  }
}

export namespace LoaderFile {
  export const writable = {
    '.json': 'application/json',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
  }

  export const supported = new Set(Object.keys(writable))

  if (typeof require !== 'undefined') {
    // eslint-disable-next-line n/no-deprecated-api
    for (const extname in require.extensions) {
      supported.add(extname)
    }
  }
}

export class BaseLoader extends EntryGroup {
  public file!: LoaderFile

  constructor(public ctx: Context) {
    super(ctx)
    ctx.on('ready', () => this.start())
  }

  async start() {
    await this.refresh()
    await this.file.checkAccess()
  }

  async refresh() {
    this._update(await this.file.read())
  }

  stop() {
    this.file?.dispose()
    return super.stop()
  }

  write() {
    return this.file!.write(this.data)
  }

  async init(baseDir: string, options: Loader.Config) {
    if (options.filename) {
      const filename = resolve(baseDir, options.filename)
      const stats = await stat(filename)
      if (stats.isFile()) {
        baseDir = dirname(filename)
        const ext = extname(filename)
        const type = LoaderFile.writable[ext]
        if (!LoaderFile.supported.has(ext)) {
          throw new Error(`extension "${ext}" not supported`)
        }
        this.file = new LoaderFile(this.ctx, filename, type)
      } else {
        baseDir = filename
        await this.findConfig(baseDir, options)
      }
    } else {
      await this.findConfig(baseDir, options)
    }
    this.ctx.provide('baseDir', baseDir, true)
  }

  private async findConfig(baseDir: string, options: Loader.Config) {
    const { name, initial } = options
    const dirents = await readdir(baseDir, { withFileTypes: true })
    for (const extension of LoaderFile.supported) {
      const dirent = dirents.find(dirent => dirent.name === name + extension)
      if (!dirent) continue
      if (!dirent.isFile()) {
        throw new Error(`config file "${dirent.name}" is not a file`)
      }
      const type = LoaderFile.writable[extension]
      const filename = resolve(baseDir, name + extension)
      this.file = new LoaderFile(this.ctx, filename, type)
      return
    }
    if (initial) {
      const type = LoaderFile.writable['.yml']
      const filename = resolve(baseDir, name + '.yml')
      this.file = new LoaderFile(this.ctx, filename, type)
      return this.file.write(initial as any)
    }
    throw new Error('config file not found')
  }
}

export namespace Import {
  export interface Config {
    url: string
    // disabled?: boolean
  }
}

export class Import extends BaseLoader {
  constructor(ctx: Context, public config: Import.Config) {
    super(ctx)
  }

  async start() {
    const { url } = this.config
    const filename = fileURLToPath(new URL(url, this.ctx.loader.file.url))
    const ext = extname(filename)
    if (!LoaderFile.supported.has(ext)) {
      throw new Error(`extension "${ext}" not supported`)
    }
    this.file = new LoaderFile(this.ctx, filename, LoaderFile.writable[ext])
    await super.start()
  }
}
