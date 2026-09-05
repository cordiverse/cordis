import { EntryChange, EntryOptions, EntryTree, isJsExpr } from '@cordisjs/plugin-loader'
import { Context, Service } from 'cordis'
import { deepEqual } from 'cosmokit'
import { basename, dirname, extname, join } from 'node:path'
import { access, constants, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { applyJournal, flatten, Journal, merge, reconcile, record } from './journal.ts'
import { applyPatches, ensureIds, ensureInsertIds, PatchIndex, PatchOptions, routeJournal } from './patch.ts'

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data['__jsExpr'],
})

const schema = yaml.JSON_SCHEMA.extend(JsExpr)

const types: Record<string, string> = {
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}

type ConfigStage = 'read' | 'parse' | 'validate'

interface Snapshot {
  content: string
  data: EntryOptions[]
}

export class ConfigFileError extends Error {
  name = 'ConfigFileError'

  constructor(public stage: ConfigStage, path: string, cause: unknown) {
    super(`failed to ${stage} config file ${path}`, { cause })
  }
}

/** The file changed under us between the pre-check and the rename. */
class StaleWriteError extends Error {
  name = 'StaleWriteError'
}

interface Anonymous {
  parent: string | null
  options: EntryOptions
}

function isENOENT(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
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

  public filename: string
  private type: string

  /** The last file state we read or wrote. */
  private cache?: Snapshot
  /** Tree-side changes that have not reached the file yet. */
  private journal: Journal = new Map()
  /** Ids we assigned to entries the file leaves anonymous. */
  private anonymous = new Map<string, Anonymous>()

  private dirtyRead = false
  private dirtyWrite = false
  private _draining?: Promise<void>

  /** Only the latest intended tree is ever applied; older ones are skipped. */
  private _pendingTree?: EntryOptions[]
  private _applyTask?: Promise<void>

  private _disposed = false
  private _seq = 0

  constructor(ctx: Context, public config: Include.Config) {
    super(ctx)
    this.enableLogs = config.enableLogs ?? ctx.fiber.entry?.parent.tree.enableLogs ?? false
    this.filename = fileURLToPath(new URL(this.config.path, this.ctx.baseUrl))
    const ext = extname(this.filename)
    if (!types[ext]) {
      throw new Error(`extension "${ext}" not supported`)
    }
    this.type = types[ext]
    this.ctx.baseUrl = new URL('.', pathToFileURL(this.filename)).href
    ensureInsertIds(config.patches, id => !!this.store[id])

    ctx.on('internal/update', (config, _, next) => {
      if (config.path !== this.config.path) return next()
      this.config = config
      ensureInsertIds(config.patches, id => !!this.store[id])
      this._scheduleApply()
      return this._applyTask
    })
  }

  private warn = (format: string, ...args: any[]) => {
    this.ctx.root.logger?.('loader').warn(format, ...args)
  }

  async* [Service.init]() {
    try {
      await this._read()
    } catch (error) {
      // Only a missing file falls back to `initial`: an existing but invalid
      // file must fail loud with its real parse error, never be mislabeled as
      // absent and then silently overwritten.
      const cause = error instanceof ConfigFileError && error.stage === 'read' ? error.cause : undefined
      if (!isENOENT(cause)) throw error
      if (!this.config.initial) {
        throw new Error(`config file not found: ${this.filename}`)
      }
      const initial = structuredClone(this.config.initial) as EntryOptions[]
      ensureIds(initial, id => !!this.store[id])
      await this._writeText(this.dump(initial))
      await this._read()
    }

    yield () => this.stop()
    await this._applyTask
  }

  async stop() {
    this._disposed = true
    this._pendingTree = undefined
    // flush what the user last did before the tree goes away
    await this.flush()
    this.root.stop()
  }

  /**
   * Resolves once every pending read and write has been processed and the
   * tree reflects the outcome. Unlike `refresh()`, this does wait for writes.
   */
  async flush() {
    while (this._draining || this._applyTask) {
      await this._draining
      await this._applyTask
    }
  }

  /** Re-read the file and reconcile the tree with it. */
  refresh() {
    this.dirtyRead = true
    this._drain()
    return this.flush()
  }

  /** Called synchronously by the loader once a tree-side change is in place. */
  commit(change: EntryChange) {
    this.context.emit('loader/config-update')
    const parent = change.group === this.root ? null : change.group.ctx.fiber.entry!.options.id
    record(this.journal, change, parent)
    this.dirtyWrite = true
    this._drain()
  }

  private _drain() {
    if (this._draining) return
    this._draining = this._loop().finally(() => {
      this._draining = undefined
    })
  }

  private async _loop() {
    while (this.dirtyRead || this.dirtyWrite) {
      if (this.dirtyRead) {
        this.dirtyRead = false
        try {
          await this._read()
        } catch (error) {
          // Half-written files are routine while the user is editing, hence
          // only a warning. With the file in an unknown state there is nothing
          // safe to write: unless another read is due, stop here and leave
          // `dirtyWrite` set for the next trigger.
          this.ctx.logger.warn(error)
          if (this.dirtyRead) continue
          return
        }
      }
      if (this.dirtyWrite) {
        this.dirtyWrite = false
        try {
          await this._write()
        } catch (error) {
          this.ctx.logger.error(error)
        }
      }
    }
  }

  private async _read() {
    let content: string
    try {
      content = await readFile(this.filename, 'utf8')
    } catch (error) {
      throw new ConfigFileError('read', this.filename, error)
    }
    if (content === this.cache?.content) return

    let data: any
    try {
      data = this.type === 'application/yaml'
        ? yaml.load(content, { schema })
        : JSON.parse(content)
    } catch (error) {
      throw new ConfigFileError('parse', this.filename, error)
    }
    // An empty or truncated file (common mid-edit: editors and `sed -i` write
    // through temp states) parses to `undefined` rather than throwing, so
    // every non-array shape is rejected here as one "invalid file" signal.
    if (!Array.isArray(data)) {
      throw new ConfigFileError('validate', this.filename, new TypeError('config file must be a top-level array'))
    }

    this._assignIds(data)

    if (this.cache) {
      const index = new PatchIndex(this.config.patches ?? [])
      const conflicts = reconcile(this.journal, flatten(this.cache.data), flatten(data), (id, key) => index.fileOwned(id, key))
      for (const { id, reason } of conflicts) {
        this.ctx.logger.error('config conflict in %C: entry %C %s; file wins', this.filename, id, reason)
      }
    }

    this.cache = { content, data }
    this._scheduleApply()
    // the file changed while tree-side changes were pending: write the merge
    if (this.journal.size) this.dirtyWrite = true
  }

  private async _write() {
    if (!this.cache || !this.journal.size) return
    const current = await readFile(this.filename, 'utf8').catch((error) => {
      if (isENOENT(error)) return undefined
      throw error
    })
    if (current === undefined) {
      this.ctx.logger.warn('config file %C is missing, %d pending change(s) kept in memory', this.filename, this.journal.size)
      return
    }
    if (current !== this.cache.content) {
      // someone else wrote the file: merge first, then come back
      this.dirtyRead = true
      this.dirtyWrite = true
      return
    }

    // Snapshot and swap: changes reported while we are writing must survive
    // into the next round instead of being cleared along with this batch.
    const batch = this.journal
    this.journal = new Map()
    const restore = () => {
      for (const [id, record] of this.journal) merge(batch, id, record)
      this.journal = batch
    }

    const data = structuredClone(this.cache.data)
    const patches = structuredClone(this.config.patches ?? [])
    if (routeJournal(batch, data, patches, this.warn)) {
      // Take the new patches now so that the tree scheduled below already
      // reflects them; the round trip through the parent only persists them.
      this.config = { ...this.config, patches }
      if (this.ctx.fiber.entry) {
        // Not awaited: the returned promise is the tree reconciliation, and
        // the drain loop must not block on fibers.
        try {
          Promise.resolve(this.ctx.fiber.update(this.config)).catch((error) => {
            this.ctx.logger.error(error)
          })
        } catch (error) {
          this.ctx.logger.error(error)
        }
      } else {
        this.ctx.logger.warn('patches of %C changed at runtime but cannot be persisted', this.filename)
      }
    }

    // nothing for the file itself (patch-only changes, or ids we assigned to
    // anonymous entries that are already part of the cache)
    if (deepEqual(data, this.cache.data)) {
      this._scheduleApply()
      return
    }
    const text = this.dump(data)

    try {
      await access(this.filename, constants.W_OK)
    } catch {
      restore()
      this.ctx.logger.warn('config file %C is read-only, %d pending change(s) kept in memory', this.filename, this.journal.size)
      return
    }

    try {
      await this._writeText(text, this.cache.content)
    } catch (error) {
      restore()
      if (error instanceof StaleWriteError) {
        this.dirtyRead = true
        this.dirtyWrite = true
        return
      }
      this.ctx.logger.warn('failed to write config file %C, %d pending change(s) kept in memory', this.filename, this.journal.size)
      throw error
    }
    this.cache = { content: text, data }
    this._scheduleApply()
  }

  /**
   * Write through a temp file and a rename, so that no reader ever sees a
   * truncated file. When `expected` is given, the rename is skipped if the
   * file no longer holds that content.
   */
  private async _writeText(text: string, expected?: string) {
    const tmp = join(dirname(this.filename), `.${basename(this.filename)}.${process.pid}.${this._seq++}.tmp`)
    try {
      await writeFile(tmp, text)
      if (expected !== undefined) {
        const current = await readFile(this.filename, 'utf8').catch(() => undefined)
        if (current !== expected) throw new StaleWriteError()
      }
      await rename(tmp, this.filename)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }

  private dump(data: EntryOptions[]) {
    return this.type === 'application/yaml'
      ? yaml.dump(data, { schema })
      : JSON.stringify(data, null, 2)
  }

  /**
   * Entries the file leaves anonymous get an id here, before the loader sees
   * them. One that looks exactly like an entry we named on the previous read
   * keeps that id, so editing a neighbor does not restart it; anything else
   * gets a fresh id. Assigned ids stay in memory until the next write.
   */
  private _assignIds(data: EntryOptions[]) {
    const used = new Set<string>()
    const pending: { options: EntryOptions; parent: string | null }[] = []
    const walk = (entries: EntryOptions[], parent: string | null) => {
      for (const options of entries) {
        if (options.id) {
          used.add(options.id)
        } else {
          pending.push({ options, parent })
        }
        if (options.group && Array.isArray(options.config)) {
          walk(options.config, options.id ?? null)
        }
      }
    }
    walk(data, null)

    const previous = this.anonymous
    this.anonymous = new Map()
    for (const { options, parent } of pending) {
      let id: string | undefined
      for (const [candidate, info] of previous) {
        if (info.parent !== parent || !deepEqual(info.options, options)) continue
        id = candidate
        previous.delete(candidate)
        break
      }
      if (!id) {
        do {
          id = Math.random().toString(16).slice(2, 10)
        } while (used.has(id) || this.store[id])
      }
      used.add(id)
      this.anonymous.set(id, { parent, options: structuredClone(options) })
      const rest = { ...options }
      for (const key of Object.keys(options)) delete options[key]
      Object.assign(options, { id }, rest)
    }
  }

  private _scheduleApply() {
    if (this._disposed || !this.cache) return
    const tree = applyPatches(this.cache.data, this.config.patches, this.warn)
    this._pendingTree = applyJournal(tree, this.journal, undefined, this.warn)
    this._applyTask ??= (async () => {
      try {
        while (this._pendingTree) {
          const tree = this._pendingTree
          this._pendingTree = undefined
          await this.root.update(tree)
        }
      } finally {
        this._applyTask = undefined
      }
    })()
  }
}

export default Include
