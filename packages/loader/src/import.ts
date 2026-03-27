import { Context, Service } from 'cordis'
import { dirname, extname, resolve } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { EntryTree } from './config/tree.ts'
import { LoaderFile } from './file.ts'

export namespace ImportTree {
  export interface Config {
    name: string
    initial?: any[]
    filename?: string
  }
}

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

  async init(baseDir: string, options: ImportTree.Config) {
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

  private async _init(baseDir: string, options: ImportTree.Config) {
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
