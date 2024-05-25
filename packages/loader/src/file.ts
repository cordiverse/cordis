import { Context } from '@cordisjs/core'
import { dirname, extname, resolve } from 'node:path'
import { access, constants, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { Entry } from './entry.ts'
import { EntryGroup } from './group.ts'
import { Loader } from './shared.ts'
import { remove } from 'cosmokit'

export class LoaderFile {
  public suspend = false
  public mutable = false
  public url: string
  public groups: BaseLoader[] = []

  private _writeTask?: NodeJS.Timeout

  constructor(public loader: Loader, public name: string, public type?: string) {
    this.url = pathToFileURL(name).href
    loader.files[name] = this
  }

  ref(group: BaseLoader) {
    this.groups.push(group)
    group.url = pathToFileURL(this.name).href
  }

  unref(group: BaseLoader) {
    remove(this.groups, group)
    if (this.groups.length) return
    clearTimeout(this._writeTask)
    delete this.loader.files[this.name]
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
    this.loader.ctx.emit('config')
    clearTimeout(this._writeTask)
    this._writeTask = setTimeout(() => {
      this._writeTask = undefined
      this._write(config)
    }, 0)
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
  static reusable = true

  protected file!: LoaderFile

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
    this.file?.unref(this)
    return super.stop()
  }

  write() {
    return this.file!.write(this.data)
  }

  _createFile(filename: string, type: string) {
    this.file = this.ctx.loader[filename] ??= new LoaderFile(this.ctx.loader, filename, type)
    this.url = this.file.url
    this.file.ref(this)
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
        this._createFile(filename, type)
      } else {
        baseDir = filename
        await this._init(baseDir, options)
      }
    } else {
      await this._init(baseDir, options)
    }
    this.ctx.provide('baseDir', baseDir, true)
  }

  private async _init(baseDir: string, options: Loader.Config) {
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
      this._createFile(filename, type)
      return
    }
    if (initial) {
      const type = LoaderFile.writable['.yml']
      const filename = resolve(baseDir, name + '.yml')
      this._createFile(filename, type)
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
    const filename = fileURLToPath(new URL(url, this.ctx.scope.entry!.parent.url))
    const ext = extname(filename)
    if (!LoaderFile.supported.has(ext)) {
      throw new Error(`extension "${ext}" not supported`)
    }
    this._createFile(filename, LoaderFile.writable[ext])
    await super.start()
  }
}
