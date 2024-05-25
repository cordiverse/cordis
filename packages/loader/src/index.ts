import { Loader } from './shared.ts'
import { promises as fs } from 'fs'
import * as dotenv from 'dotenv'
import * as path from 'path'

export * from './internal.ts'
export * from './shared.ts'

const oldEnv = { ...process.env }

namespace NodeLoader {
  export interface Options extends Loader.Options {
    type?: 'commonjs' | 'module' | 'vm-module'
  }
}

class NodeLoader extends Loader<NodeLoader.Options> {
  static readonly exitCode = 51

  async start() {
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
        const raw = await fs.readFile(path.resolve(this.baseDir, filename), 'utf8')
        Object.assign(override, dotenv.parse(raw))
      } catch {}
    }

    // override process.env
    for (const key in override) {
      process.env[key] = override[key]
    }

    return await super.start()
  }

  exit(code = NodeLoader.exitCode) {
    const body = JSON.stringify(this.envData)
    process.send?.({ type: 'shared', body }, (err: any) => {
      if (err) this.app.emit('internal/error', 'failed to send shared data')
      this.app.emit('internal/info', 'trigger full reload')
      process.exit(code)
    })
  }
}

export default NodeLoader
