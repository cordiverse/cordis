import { EntryOptions, EntryTree } from '@cordisjs/plugin-loader'
import type {} from '@cordisjs/plugin-logger'
import { Context, Service } from 'cordis'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigFile } from './file.ts'

export * from './file.ts'

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
    url: string
    initial?: any[]
    patches?: PatchOptions[]
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

  private applyPatches(data: EntryOptions[]): EntryOptions[] {
    const { patches } = this.config
    if (!patches?.length) return data

    // Build a flat map of id -> entry (including nested groups)
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
          // Insert into specific group
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
          // Insert into root group
          data.push(...insert)
        }
        continue
      }

      // Patch mode: modify existing entry
      if (!id) {
        this.ctx.root.logger?.('loader').warn('patch: id is required for non-insert patches')
        continue
      }

      const target = entryMap.get(id)
      if (!target) {
        this.ctx.root.logger?.('loader').warn('patch: entry %c not found', id)
        continue
      }

      // Validate name consistency
      if (name && name !== target.name) {
        this.ctx.root.logger?.('loader').warn(
          'patch: name mismatch for %c (expected %c, got %c), skipping',
          id, target.name, name,
        )
        continue
      }

      // Apply overrides (all fields except id and name)
      for (const [key, value] of Object.entries(overrides)) {
        if (key === 'id') continue
        target[key] = value
      }
    }

    return data
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
        this.file.write(initial as any)
        await this.file.read()
      } else {
        throw new Error(`config file not found: ${filename}`)
      }
    }

    yield () => this.stop()
    const data = this.applyPatches([...this.file.data!])
    this.root.update(data)
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
