import { EntryOptions, EntryTree, isJsExpr } from '@cordisjs/plugin-loader'
import type {} from '@cordisjs/plugin-logger'
import { Context, Service } from 'cordis'
import { extname } from 'node:path'
import { access, constants, readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data['__jsExpr'],
})

const schema = yaml.JSON_SCHEMA.extend(JsExpr)

const writable: Record<string, string> = {
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}

const supported = new Set(Object.keys(writable))

export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}

export namespace Include {
  export interface Config {
    path: string
    initial?: any[]
    patches?: PatchOptions[]
    enableLogs?: boolean
  }
}

export class Include extends EntryTree {
  static inject = ['loader']

  public filename!: string
  private type?: string
  private readonly!: boolean
  private content?: string
  private data?: EntryOptions[]
  private writeTask?: NodeJS.Timeout

  constructor(ctx: Context, public config: Include.Config) {
    super(ctx)
    this.enableLogs = config.enableLogs ?? ctx.fiber.entry?.parent.tree.enableLogs ?? false
    ctx.on('internal/update', (config, _, next) => {
      if (config.path !== this.config.path) return next()
      this.root.update(this.data!)
    })
  }

  private async checkAccess() {
    if (!this.type) return
    try {
      await access(this.filename, constants.W_OK)
    } catch {
      this.readonly = true
    }
  }

  private async read(forced = false) {
    const content = await readFile(this.filename, 'utf8')
    if (!forced && this.content === content) return false
    this.content = content
    if (this.type === 'application/yaml') {
      this.data = yaml.load(this.content, { schema }) as any
    } else if (this.type === 'application/json') {
      this.data = JSON.parse(this.content) as any
    } else {
      const module = await import(this.filename)
      this.data = module.default || module
    }
    await this.checkAccess()
    return true
  }

  private applyPatches(data: EntryOptions[]): EntryOptions[] {
    const { patches } = this.config
    if (!patches?.length) return data

    const entryMap = new Map<string, EntryOptions>()
    const buildMap = (entries: EntryOptions[]) => {
      for (const entry of entries) {
        if (entry.id) entryMap.set(entry.id, entry)
        if (entry.group && Array.isArray(entry.config)) {
          buildMap(entry.config)
        }
      }
    }
    buildMap(data)

    for (const patch of patches) {
      const { id, insert, name, ...overrides } = patch

      if (insert) {
        if (id) {
          const target = entryMap.get(id)
          if (!target) {
            this.ctx.root.logger?.('loader').warn('patch insert: entry %c not found', id)
            continue
          }
          if (!target.group) {
            this.ctx.root.logger?.('loader').warn('patch insert: entry %c is not a group', id)
            continue
          }
          if (!Array.isArray(target.config)) target.config = []
          target.config.push(...insert)
        } else {
          data.push(...insert)
        }
        continue
      }

      if (!id) {
        this.ctx.root.logger?.('loader').warn('patch: id is required for non-insert patches')
        continue
      }

      const target = entryMap.get(id)
      if (!target) {
        this.ctx.root.logger?.('loader').warn('patch: entry %c not found', id)
        continue
      }

      if (name && name !== target.name) {
        this.ctx.root.logger?.('loader').warn(
          'patch: name mismatch for %c (expected %c, got %c), skipping',
          id, target.name, name,
        )
        continue
      }

      for (const [key, value] of Object.entries(overrides)) {
        if (key === 'id') continue
        target[key] = value
      }
    }

    return data
  }

  async* [Service.init]() {
    const { path, initial } = this.config
    const baseUrl = this.ctx.fiber.entry?.parent.tree.ctx.baseUrl ?? pathToFileURL(process.cwd() + '/').href
    this.filename = fileURLToPath(new URL(path, baseUrl))
    const ext = extname(this.filename)
    if (!supported.has(ext)) {
      throw new Error(`extension "${ext}" not supported`)
    }
    this.type = writable[ext]
    this.readonly = !this.type
    this.ctx.baseUrl = new URL('.', pathToFileURL(this.filename)).href

    try {
      await this.read()
    } catch {
      if (initial) {
        this.writeFile(initial as any)
        await this.read()
      } else {
        throw new Error(`config file not found: ${this.filename}`)
      }
    }

    yield () => this.stop()
    const data = this.applyPatches([...this.data!])
    await this.root.update(data)
  }

  stop() {
    this.root.stop()
  }

  async refresh() {
    if (!await this.read()) return
    this.root.update(this.data!)
  }

  private async _writeFile(config: EntryOptions[]) {
    if (this.readonly) {
      throw new Error(`cannot overwrite readonly config`)
    }
    if (this.type === 'application/yaml') {
      this.content = yaml.dump(config, { schema })
    } else if (this.type === 'application/json') {
      this.content = JSON.stringify(config, null, 2)
    }
    await writeFile(this.filename + '.tmp', this.content!)
    await rename(this.filename + '.tmp', this.filename)
  }

  private writeFile(config: EntryOptions[]) {
    clearTimeout(this.writeTask)
    this.writeTask = setTimeout(() => {
      this.writeTask = undefined
      this._writeFile(config)
    }, 0)
  }

  write() {
    this.context.emit('loader/config-update')
    return this.writeFile(this.root.data)
  }
}

export default Include
