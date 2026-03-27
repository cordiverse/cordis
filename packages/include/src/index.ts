import { ImportTree, LoaderFile } from '@cordisjs/plugin-loader'
import { Context, Service } from 'cordis'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

export namespace Include {
  export interface Config {
    url: string
  }
}

export class Include extends ImportTree {
  constructor(ctx: Context, public config: Include.Config) {
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

export default Include
