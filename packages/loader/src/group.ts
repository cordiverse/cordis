import { Context } from '@cordisjs/core'
import { FileLoader } from './file.ts'
import { Entry } from './entry.ts'
import { fileURLToPath } from 'node:url'
import { extname } from 'node:path'

export class EntryGroup {
  public data: Entry.Options[] = []

  constructor(public ctx: Context) {
    ctx.on('dispose', () => this.stop())
  }

  async _create(options: Omit<Entry.Options, 'id'>) {
    const id = this.ctx.loader.ensureId(options)
    const entry = this.ctx.loader.entries[id] ??= new Entry(this.ctx.loader, this)
    entry.parent = this
    await entry.update(options as Entry.Options)
    return id
  }

  _unlink(options: Entry.Options) {
    const config = this.data
    const index = config.indexOf(options)
    if (index >= 0) config.splice(index, 1)
  }

  _remove(id: string) {
    const entry = this.ctx.loader.entries[id]
    if (!entry) return
    entry.stop()
    this._unlink(entry.options)
    delete this.ctx.loader.entries[id]
  }

  _update(config: Entry.Options[]) {
    const oldConfig = this.data as Entry.Options[]
    this.data = config
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id ?? Symbol('anonymous'), options]))

    // update inner plugins
    for (const id of Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]) {
      if (newMap[id]) {
        this._create(newMap[id]).catch((error) => {
          this.ctx.emit('internal/error', error)
        })
      } else {
        this._remove(id)
      }
    }
  }

  write() {
    if (this.ctx.scope.entry) {
      return this.ctx.scope.entry!.parent.write()
    } else {
      return this.ctx.loader.file.write(this.ctx.loader.data)
    }
  }

  stop() {
    for (const options of this.data) {
      this._remove(options.id)
    }
  }
}

export const kGroup = Symbol.for('cordis.group')

export interface GroupOptions {
  name?: string
  initial?: Omit<Entry.Options, 'id'>[]
  allowed?: string[]
}

export function defineGroup(config?: Entry.Options[], options: GroupOptions = {}) {
  options.initial = config

  class Group extends EntryGroup {
    static reusable = true
    static [kGroup] = options

    constructor(public ctx: Context) {
      super(ctx)
      ctx.scope.entry!.children = this
      ctx.accept((config: Entry.Options[]) => {
        this._update(config)
      }, { passive: true, immediate: true })
    }
  }

  return Group
}

export const group = defineGroup()

export class BaseImportLoader extends EntryGroup {
  public file!: FileLoader

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
}

export namespace Import {
  export interface Config {
    url: string
    // disabled?: boolean
  }
}

export class Import extends BaseImportLoader {
  constructor(ctx: Context, public config: Import.Config) {
    super(ctx)
  }

  async start() {
    const { url } = this.config
    const filename = fileURLToPath(new URL(url, this.ctx.loader.file.url))
    const ext = extname(filename)
    if (!FileLoader.supported.has(ext)) {
      throw new Error(`extension "${ext}" not supported`)
    }
    this.file = new FileLoader(this.ctx.loader, filename, FileLoader.writable[ext])
    this._update(await this.file.read())
    await this.file.checkAccess()
  }
}
