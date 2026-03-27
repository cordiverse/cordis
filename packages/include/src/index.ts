import { EntryOptions, EntryTree } from '@cordisjs/plugin-loader'
import { Context, Service } from 'cordis'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigFile } from './file.ts'

export * from './file.ts'

export namespace Include {
  export interface Config {
    url: string
    initial?: EntryOptions[]
  }
}

export class Include extends EntryTree {
  public file!: ConfigFile

  constructor(ctx: Context, public config: Include.Config) {
    super(ctx)
    ctx.on('internal/update', (config, _, next) => {
      if (config.url !== this.config.url) return next()
      this.root.update(this.file.data!)
    })
  }

  async* [Service.init]() {
    const { url, initial } = this.config
    const filename = fileURLToPath(new URL(url, this.ctx.fiber.entry!.parent.tree.url))
    const ext = extname(filename)
    if (!ConfigFile.supported.has(ext)) {
      throw new Error(`extension "${ext}" not supported`)
    }
    const type = ConfigFile.writable[ext]
    this.file = new ConfigFile(filename, type)
    this.file.ref(this)

    try {
      await this.file.read()
    } catch {
      if (initial) {
        this.file.write(initial)
        await this.file.read()
      } else {
        throw new Error(`config file not found: ${filename}`)
      }
    }

    yield () => this.stop()
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
}

export default Include
