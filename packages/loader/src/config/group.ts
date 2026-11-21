import { Context, Service } from 'cordis'
import { isNullable } from 'cosmokit'
import { Entry, EntryOptions } from './entry.ts'
import { EntryTree } from './tree.ts'
import { EntryValidationError, formatIssues, formatLocation, Issue, relocate, validateOptions } from './utils.ts'

/** The ids that appear more than once in one config list. */
function repeatedIds(config: EntryOptions[]): Set<string | symbol> {
  const seen = new Set<string | symbol>()
  const repeated = new Set<string | symbol>()
  for (const options of config) {
    const id = options?.id
    if (id === undefined) continue
    if (seen.has(id)) repeated.add(id)
    else seen.add(id)
  }
  return repeated
}

export class EntryGroup {
  static readonly key = Symbol.for('cordis.group')

  public data: EntryOptions[] = []

  constructor(public ctx: Context, public tree: EntryTree) {
    const entry = ctx[Entry.key]
    if (entry) entry.subgroup = this
  }

  get context(): Context {
    return this.ctx
  }

  async create(options: Omit<EntryOptions, 'id'> & { id?: string }) {
    const issues = validateOptions(options, EntryTree.sep)
    if (issues.length) throw this._reject(options as EntryOptions, issues)
    const id = this.tree.ensureId(options)
    const entry: Entry = this.tree.store[id] ??= new Entry(this.ctx.loader)
    // Entry may be transferred from another group,
    // so we need to update the parent reference.
    entry.parent = this
    // Use `create: true` to replace existing entry.options.
    await entry.update(options, true, true)
    return entry.id
  }

  getOuterStack(id: string): string[] {
    const location = this.tree.getLocation(id, [])
    const frames = location ? [`    at ${id} (${formatLocation(location)})`] : []
    return [...frames, ...this.ctx[Entry.key]?.getOuterStack() ?? []]
  }

  private _reject(options: EntryOptions, issues: Issue[]) {
    const error = new EntryValidationError(issues)
    const id = options?.id
    if (isNullable(id)) return error
    // unregistered first, so the disposal is not taken for a self-dispose
    const entry = this.tree.store[id]
    if (entry) {
      delete this.tree.store[id]
      entry.dispose()
    }
    const frames = this.getOuterStack(id)
    if (!frames.length) return error
    const locate = (path: PropertyKey[]) => this.tree.getLocation(id, path)
    relocate(error, formatIssues('invalid entry options', issues, locate), frames)
    return error
  }

  unlink(options: EntryOptions) {
    const config = this.data
    const index = config.indexOf(options)
    if (index >= 0) config.splice(index, 1)
  }

  remove(id: string, isDispose = false) {
    const entry = this.tree.store[id]
    // an entry that another group already adopted (a file-driven transfer) belongs
    // to that group now
    if (!entry || entry.parent !== this) return
    // Unregister before disposing: the `dispose` callback of the entry fiber
    // distinguishes "removed by the loader" from "disposed itself" by checking
    // whether the entry is still in the store.
    delete this.tree.store[id]
    entry.dispose()
    if (!isDispose) {
      this.unlink(entry.options)
    }
  }

  async update(config: EntryOptions[]) {
    const oldConfig = this.data as EntryOptions[]
    this.data = config
    const repeated = repeatedIds(config)
    // A duplicate is a property of the config, not of this reload: `update` runs on
    // every edit, and an unchanged duplicate would otherwise print a line per edit.
    // An id that stops being repeated drops out of `before`, so a later one is news.
    const before = repeatedIds(oldConfig)
    for (const id of repeated) {
      if (before.has(id)) continue
      this.ctx.logger.error('duplicate entry id %C, only the last one takes effect', id)
    }
    const oldMap = Object.fromEntries(oldConfig.map(options => [options?.id, options]))
    // non-objects are rejected by `create`
    const newMap = Object.fromEntries(config.map(options => [options?.id ?? Symbol('anonymous'), options]))

    // update inner components
    const ids = Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]
    await Promise.all(ids.map(async (id) => {
      if (newMap[id]) {
        await this.create(newMap[id]).catch((error) => {
          this.ctx.logger.error(error)
        })
      } else {
        this.remove(id)
      }
    }))
  }

  stop() {
    for (const options of this.data) {
      this.remove(options.id, true)
    }
  }
}

export class Group extends EntryGroup {
  static initial: Omit<EntryOptions, 'id'>[] = []
  static readonly [EntryGroup.key] = true

  constructor(public ctx: Context, public config: EntryOptions[]) {
    super(ctx, ctx[Entry.key]!.parent.tree)
    ctx.on('internal/update', config => this.update(config))
  }

  async* [Service.init]() {
    yield () => this.stop()
    await this.update(this.config)
  }
}
