import { Context } from '@cordisjs/core'
import { dirname, extname, resolve } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { EntryTree } from './tree.ts'
import { FileRef, LoaderFile } from './file.ts'
import Loader from '../loader.ts'

export class ImportTree<C extends Context = Context> extends EntryTree<C> {
  static reusable = true

  public ref!: FileRef

  constructor(public ctx: C) {
    super(ctx)
    ctx.on('ready', () => this.start())
    ctx.on('dispose', () => this.stop())
  }

  async start() {
    await this.refresh()
    await this.ref.file.checkAccess()
  }

  async refresh() {
    this.root.update(await this.ref.file.read())
  }

  stop() {
    this.ref?.stop()
    return this.root.stop()
  }

  write() {
    this.context.emit('loader/config-update')
    return this.ref.file.write(this.root.data)
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
        this.ref = new LoaderFile(this.ctx.loader, filename, type).ref()
      } else {
        baseDir = filename
        await this._init(baseDir, options)
      }
    } else {
      await this._init(baseDir, options)
    }
    this.ctx.provide('baseDir', baseDir, true)
    this.url = this.ref.url
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
      this.ref = new LoaderFile(this.ctx.loader, filename, type).ref()
      return
    }
    if (initial) {
      const type = LoaderFile.writable['.yml']
      const filename = resolve(baseDir, name + '.yml')
      this.ref = new LoaderFile(this.ctx.loader, filename, type).ref()
      return this.ref.file.write(initial as any)
    }
    throw new Error('config file not found')
  }
}

export namespace Import {
  export interface Config {
    url: string
  }
}

export class Import extends ImportTree {
  constructor(ctx: Context, public config: Import.Config) {
    super(ctx)
  }

  async start() {
    const { url } = this.config
    const filename = fileURLToPath(new URL(url, this.ctx.scope.entry!.parent.tree.url))
    const ext = extname(filename)
    if (!LoaderFile.supported.has(ext)) {
      throw new Error(`extension "${ext}" not supported`)
    }
    this.ref = new LoaderFile(this.ctx.loader, filename, LoaderFile.writable[ext]).ref()
    await super.start()
  }
}
