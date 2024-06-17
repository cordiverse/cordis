import Module from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { Loader } from './loader.ts'
import * as dotenv from 'dotenv'
import * as path from 'node:path'

export * from './internal.ts'
export * from './loader.ts'

type ModuleLoad = (request: string, parent: Module, isMain: boolean) => any

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
        const raw = await readFile(path.resolve(this.ctx.baseDir, filename), 'utf8')
        Object.assign(override, dotenv.parse(raw))
      } catch {}
    }

    // override process.env
    for (const key in override) {
      process.env[key] = override[key]
    }
  }

  async start() {
    const originalLoad: ModuleLoad = Module['_load']
    Module['_load'] = ((request, parent, isMain) => {
      try {
        return originalLoad(request, parent, isMain)
      } catch (e: any) {
        if (e.code !== 'ERR_REQUIRE_ESM' || !this.internal) throw e
        try {
          // TODO support hmr for cjs-esm interop
          const result = this.internal.resolveSync(request, pathToFileURL(parent.filename).href, {})
          const job = result?.format === 'module'
            ? this.internal.loadCache.get(result.url)
            : undefined
          if (job) return job?.module?.getNamespace()
        } catch {
          throw e
        }
      }
    }) as ModuleLoad

    await super.start()
  }

  exit(code = NodeLoader.exitCode) {
    const body = JSON.stringify(this.envData)
    process.send?.({ type: 'shared', body }, (err: any) => {
      if (err) this.ctx.emit(this.ctx, 'internal/error', 'failed to send shared data')
      this.ctx.emit(this.ctx, 'internal/info', 'trigger full reload')
      process.exit(code)
    })
  }
}

export default NodeLoader
