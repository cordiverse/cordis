import { Module } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service } from '@cordisjs/core'
import { Loader } from './loader.ts'
import * as dotenv from 'dotenv'
import { ModuleLoader } from './internal.ts'

export * from './internal.ts'
export * from './loader.ts'

type ModuleLoad = (request: string, parent: Module, isMain: boolean) => any

namespace NodeLoader {
  export interface Config extends Loader.Config {}
}

class NodeLoader extends Loader {
  static readonly exitCode = 51

  public internal = ModuleLoader.fromInternal()

  async* [Service.init]() {
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

    // load .env files
    const override = {}
    const envFiles = ['.env', '.env.local']
    for (const filename of envFiles) {
      try {
        const raw = await readFile(join(process.cwd(), filename), 'utf8')
        Object.assign(override, dotenv.parse(raw))
      } catch {}
    }
    for (const key in override) {
      process.env[key] = override[key]
    }

    yield* super[Service.init]()
  }

  exit(code = NodeLoader.exitCode) {
    const body = JSON.stringify(this.envData)
    process.send?.({ type: 'shared', body }, (err: any) => {
      if (err) this.ctx.emit(this.ctx, 'internal/error', 'failed to send shared data')
      this.ctx.root.logger?.('loader').info('trigger full reload')
      process.exit(code)
    })
  }
}

export default NodeLoader
