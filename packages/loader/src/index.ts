import { Loader } from './shared.ts'
import { promises as fs } from 'fs'
import * as dotenv from 'dotenv'
import * as path from 'path'

export * from './internal.ts'
export * from './shared.ts'

const oldEnv = { ...process.env }

namespace NodeLoader {
  export interface Config extends Loader.Config {}
}

class NodeLoader extends Loader {
  static readonly exitCode = 51

  async init(baseDir: string, options: Loader.Config) {
    await super.init(baseDir, options)

    // restore process.env
    for (const key in process.env) {
      if (key in oldEnv) {
        process.env[key] = oldEnv[key]
      } else {
        delete process.env[key]
      }
    }

    // load .env files
    const override = {}
    const envFiles = ['.env', '.env.local']
    for (const filename of envFiles) {
      try {
        const raw = await fs.readFile(path.resolve(this.ctx.baseDir, filename), 'utf8')
        Object.assign(override, dotenv.parse(raw))
      } catch {}
    }

    // override process.env
    for (const key in override) {
      process.env[key] = override[key]
    }
  }

  exit(code = NodeLoader.exitCode) {
    const body = JSON.stringify(this.envData)
    process.send?.({ type: 'shared', body }, (err: any) => {
      if (err) this.ctx.emit('internal/error', 'failed to send shared data')
      this.ctx.emit('internal/info', 'trigger full reload')
      process.exit(code)
    })
  }
}

export default NodeLoader
