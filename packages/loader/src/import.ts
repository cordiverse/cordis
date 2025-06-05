import { Context, Service } from '@cordisjs/core'
import { dirname, extname, resolve } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { EntryTree } from './config/tree.ts'
import { LoaderFile } from './file.ts'
import Loader from './loader.ts'

export class ImportTree<C extends Context = Context> extends EntryTree<C> {
  public file!: LoaderFile

  async* [Service.init]() {
    yield () => this.stop()
    await this.file.read()
    this.root.update(this.file.data!)
  }

  stop() {
    this.file?.unref(this)
    this.root.stop()
  }

  write() {
    this.context.emit('loader/config-update')
    return this.file.write(this.root.data)
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
        this.file = new LoaderFile(filename, type)
        this.file.ref(this)
      } else {
        baseDir = filename
        await this._init(baseDir, options)
      }
    } else {
      await this._init(baseDir, options)
    }
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
      this.file = new LoaderFile(filename, type)
      this.file.ref(this)
      return
    }
    if (initial) {
      const type = LoaderFile.writable['.yml']
      const filename = resolve(baseDir, name + '.yml')
      this.file = new LoaderFile(filename, type)
      this.file.ref(this)
      return this.file.write(initial as any)
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
    ctx.on('internal/update', (config, _, next) => {
      if (config.url !== this.config.url) return next()
      this.root.update(this.file.data!)
    })
  }

  async* [Service.init]() {
    const { url } = this.config
    const filename = fileURLToPath(new URL(url, this.ctx.fiber.entry!.parent.tree.url))
    const ext = extname(filename)
    if (!LoaderFile.supported.has(ext)) {
      throw new Error(`extension "${ext}" not supported`)
    }
    this.file = new LoaderFile(filename, LoaderFile.writable[ext])
    this.file.ref(this)
    yield* super[Service.init]()
  }
}
