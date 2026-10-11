import { EntryChange, EntryOptions, EntryTree, isJsExpr } from '@cordisjs/plugin-loader'
import { Context, Service } from 'cordis'
import { deepEqual } from 'cosmokit'
import { basename, dirname, extname, join } from 'node:path'
import { access, constants, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { applyJournal, flatten, Journal, merge, reconcile, record } from './journal.ts'
import { applyPatches, ensureIds, ensureInsertIds, PatchIndex, PatchOptions, routeJournal } from './patch.ts'
import type {} from '@cordisjs/plugin-hmr'

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

const RENAME_RETRIES = 10
const RENAME_BACKOFF = 20

/**
 * On Windows a rename over a file that another process holds open (typically
 * an antivirus scanning what we just wrote) fails with one of these; the lock
 * is normally gone within milliseconds. A bounded retry is cheap enough to
 * apply on every platform.
 */
function isTransientRenameError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EACCES' || code === 'EPERM' || code === 'EBUSY'
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
  // invariant: retries route against the ownership before an accepted patch handoff.
  private replay?: { patches: PatchOptions[]; accepted: PatchOptions[]; batch: Journal }
  /** Ids we assigned to entries the file leaves anonymous. */
  private anonymous = new Map<string, Anonymous>()

  private dirtyRead = false
  private dirtyWrite = false
  private _draining?: Promise<void>
  /** Bumped only from `commit`, so a read abort's leftover `dirtyWrite` is not another attempt. */
  private _commitEpoch = 0

  /** Only the latest intended tree is ever applied; older ones are skipped. */
  private _pendingTree?: EntryOptions[]
  private _applyTask?: Promise<void>

  private ownerConfig: any

  private _disposed = false
  private _seq = 0

  constructor(ctx: Context, public config: Include.Config) {
    super(ctx)
    this.ownerConfig = ctx.fiber.entry?.options.config
    this.enableLogs = config.enableLogs ?? ctx.fiber.entry?.parent.tree.enableLogs ?? false
    this.filename = fileURLToPath(new URL(this.config.path, this.ctx.baseUrl))
    const ext = extname(this.filename)
    if (!types[ext]) {
      throw new Error(`extension "${ext}" not supported`)
    }
    this.type = types[ext]
    this.ctx.baseUrl = new URL('.', pathToFileURL(this.filename)).href
    ensureInsertIds(config.patches, id => !!this.store[id])

    ctx.on('internal/update', (config, next) => {
      if (config.path !== this.config.path) return next()
      this.config = config
      this.ownerConfig = ctx.fiber.entry?.options.config
      ensureInsertIds(config.patches, id => !!this.store[id])
      this._scheduleApply()
      return this._applyTask
    })

    ctx.inject(['hmr'], (ctx) => {
      ctx.hmr.watch(this.filename, () => this.refresh())
    })
  }

  private warn = (format: string, ...args: any[]) => {
    this.ctx.root.logger?.('loader').warn(format, ...args)
  }

  async* [Service.init]() {
    try {
      await this._read()
    } catch (error) {
      // only a missing file falls back to `initial`
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
    // Flush what the user last did before the tree goes away; this is also the
    // last attempt for changes a failed write left in the journal.
    if (this.journal.size || this.replay) {
      this.dirtyWrite = true
      this._drain()
    }
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
    this._commitEpoch++
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
    // An empty or truncated file (routine mid-edit) parses to `undefined`, so
    // every non-array shape is rejected here as one "invalid file" signal.
    if (!Array.isArray(data)) {
      throw new ConfigFileError('validate', this.filename, new TypeError('config file must be a top-level array'))
    }

    this._assignIds(data)

    if (this.cache) {
      const index = new PatchIndex(this.replay?.patches ?? this.config.patches ?? [])
      const base = flatten(this.cache.data)
      const theirs = flatten(data)
      if (this.replay) {
        for (const [id, change] of this.journal) {
          if (change.kind !== 'upsert' || change.parent === undefined) continue
          const owner = index.entry(id)
          if (owner.type !== 'insert' || index.entry(change.parent).type !== 'file') continue
          if (base.has(id) || !theirs.has(id)) continue
          owner.list.splice(owner.list.indexOf(owner.options), 1)
          this.journal.delete(id)
          this.ctx.logger.error('config conflict in %C: entry %C added in file during move; file wins', this.filename, id)
        }
      }
      const conflicts = reconcile(this.journal, base, theirs, (id, key) => index.fileOwned(id, key))
      for (const { id, reason } of conflicts) {
        this.ctx.logger.error('config conflict in %C: entry %C %s; file wins', this.filename, id, reason)
      }
    }

    this.cache = { content, data }
    this._scheduleApply()
    // the file changed while tree-side changes were pending: write the merge
    if (this.journal.size || this.replay) this.dirtyWrite = true
  }

  /**
   * Wait out the drain already in progress. A `commit` that arrives as that
   * drain clears its flag starts one more. Leftover `dirtyWrite` from a read
   * abort is not another attempt.
   */
  private async _flushWrites() {
    let seen = this._commitEpoch
    for (;;) {
      while (this._draining) await this._draining
      if (this._commitEpoch === seen) return
      seen = this._commitEpoch
      if (!this.dirtyRead && !this.dirtyWrite) continue
      this._drain()
      if (!this._draining) return
    }
  }

  private refusePatches() {
    this.ctx.logger.warn('patches of %C changed at runtime but cannot be persisted', this.filename)
    return false
  }

  private async _persistPatches(patches: PatchOptions[]) {
    const next = { ...this.config, patches }
    const fiber = this.ctx.fiber
    const entry = fiber.entry
    if (!entry) return this.refusePatches()
    const parent = entry.parent.tree
    // invariant: shutdown retains the owning options and config, replacement does not.
    if (flatten(parent.root.data).get(entry.options.id)?.options !== entry.options
      || !deepEqual(entry.options.config, this.ownerConfig)) return this.refusePatches()
    if (fiber.uid !== null) {
      const previous = entry.options.config
      // Not awaited: the returned promise is the tree reconciliation, and
      // the drain loop must not block on fibers. `internal/config` throws
      // before `internal/commit`.
      try {
        Promise.resolve(fiber.update(next)).catch((error) => {
          this.ctx.logger.error(error)
        })
      } catch (error) {
        this.ctx.logger.error(error)
        if (entry.options.config === previous) return false
      }
      this.config = next
      this.ownerConfig = entry.options.config
      return true
    }

    // `Fiber.dispose` clears `uid` before effect disposers, so `stop()` cannot
    // call `Fiber.update`. The ancestor's `internal/commit` listener is itself
    // an effect and may already be gone. Write the parent commit directly.
    if (fiber.parent.fiber?.entry === entry) return this.refusePatches()
    const previousConfig = entry.options.config
    try {
      const unparse = fiber.runtime?.Config?.['simplify']
      const legacy = { ...entry.options }
      entry.options.config = typeof unparse === 'function' ? unparse(next) : next
      parent.commit({
        id: entry.options.id,
        group: entry.parent,
        options: entry.options,
        legacy,
      })
    } catch (error) {
      entry.options.config = previousConfig
      this.ctx.logger.error(error)
      return false
    }
    const committed = this.ownerConfig = entry.options.config
    if (parent instanceof Include && parent !== this) {
      await parent._flushWrites()
      if (parent.journal.has(entry.options.id)) return this.refusePatches()
      try {
        const persisted = applyPatches(parent.cache?.data ?? [], parent.config.patches, this.warn)
        if (!deepEqual(flatten(persisted).get(entry.options.id)?.options.config, committed)) return this.refusePatches()
      } catch (error) {
        this.ctx.logger.error(error)
        return this.refusePatches()
      }
    }
    fiber.config = next
    this.config = next
    this.ownerConfig = entry.options.config
    return true
  }

  private async _write() {
    if (!this.cache || (!this.journal.size && !this.replay)) return
    if (this.replay && !deepEqual(this.config.patches ?? [], this.replay.accepted)) {
      this.refusePatches()
      return
    }
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

    // Snapshot and swap: changes reported while we are writing belong to the
    // next round.
    const batch = this.journal
    this.journal = new Map()
    const restore = () => {
      for (const [id, record] of this.journal) merge(batch, id, record)
      this.journal = batch
    }

    const keep = (error: unknown): never => {
      restore()
      this.ctx.logger.warn('failed to write config file %C, %d pending change(s) kept in memory', this.filename, this.journal.size)
      throw error
    }

    let data: EntryOptions[]
    let patches: PatchOptions[]
    let original: PatchOptions[]
    try {
      data = structuredClone(this.cache.data)
      original = structuredClone(this.replay?.patches ?? this.config.patches ?? [])
      patches = structuredClone(original)
    } catch (error) {
      return keep(error)
    }
    let patched = false
    try {
      patched = routeJournal(batch, data, patches, this.warn)
      patched ||= !!this.replay && !deepEqual(patches, this.config.patches ?? [])
    } catch (error) {
      return keep(error)
    }
    if (patched) {
      const previous = this.replay
      this.replay = { patches: original, accepted: patches, batch }
      if (!await this._persistPatches(patches)) {
        this.replay = previous
        restore()
        return
      }
    }

    // nothing for the file itself (patch-only changes, or ids we assigned to
    // anonymous entries that are already part of the cache)
    if (deepEqual(data, this.cache.data)) {
      this.replay = undefined
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
    this.replay = undefined
    this._scheduleApply()
  }

  /**
   * Write through a temp file and a rename, so that no reader ever sees a
   * truncated file. When `expected` is given, the rename (and every retry of
   * it) only goes ahead while the file still holds that content.
   */
  private async _writeText(text: string, expected?: string) {
    const tmp = join(dirname(this.filename), `.${basename(this.filename)}.${process.pid}.${this._seq++}.tmp`)
    try {
      await writeFile(tmp, text)
      for (let attempt = 0; ; attempt++) {
        if (expected !== undefined) {
          const current = await readFile(this.filename, 'utf8').catch((error) => {
            if (isENOENT(error)) return undefined
            throw error
          })
          if (current !== expected) throw new StaleWriteError()
        }
        try {
          await rename(tmp, this.filename)
          return
        } catch (error) {
          if (attempt >= RENAME_RETRIES || !isTransientRenameError(error)) throw error
        }
        await sleep(RENAME_BACKOFF * (attempt + 1))
      }
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
    const patches = this.replay && deepEqual(this.config.patches ?? [], this.replay.accepted)
      ? this.replay.patches : this.config.patches
    const tree = applyPatches(this.cache.data, patches, this.warn)
    if (this.replay && patches === this.replay.patches) applyJournal(tree, this.replay.batch, undefined, this.warn)
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
