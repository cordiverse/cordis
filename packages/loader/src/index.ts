import {} from '@cordisjs/logger'
import Loader from './shared.js'
import { promises as fs } from 'fs'
import * as dotenv from 'dotenv'
import * as path from 'path'

export * from './shared.js'

const oldEnv = { ...process.env }

namespace NodeLoader {
  export interface Options extends Loader.Options {
    type?: 'commonjs' | 'module' | 'vm-module'
  }
}

class NodeLoader extends Loader<NodeLoader.Options> {
  async readConfig() {
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

    return await super.readConfig()
  }

  async import(name: string) {
    try {
      return await import(name)
    } catch (err: any) {
      this.app.logger('loader').error(err)
    }
  }

  fullReload(code = Loader.exitCode) {
    const body = JSON.stringify(this.envData)
    process.send?.({ type: 'shared', body }, (err: any) => {
      if (err) this.app.logger('loader').error('failed to send shared data')
      this.app.logger('loader').info('trigger full reload')
      process.exit(code)
    })
  }
}

export default NodeLoader
