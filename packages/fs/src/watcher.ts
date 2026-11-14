import { Context } from 'cordis'
import { Awaitable } from 'cosmokit'

export type WatchFilter = string[] | ((path: string, isDirectory: boolean) => boolean)

export interface WatchOptions {
  /**
   * Decides which entries below a watched directory are kept.
   */
  filter?: WatchFilter
}

export interface WatchEvents {
  /** A file at or below the watched location is modified. */
  change(url: URL): Awaitable<void>
  /** The initial scan is done. A listener added afterwards is called at once. */
  ready(): Awaitable<void>
  /** An error is logged as a warning without a listener. */
  error(error: unknown): Awaitable<void>
}

// a subscription made by `on()`, apart from any other with the same listener
interface Hook<F> {
  listener: F
  removed?: boolean
}

type Hooks = { [K in keyof WatchEvents]: Set<Hook<WatchEvents[K]>> }

/**
 * A watch on a location, which ends with the calling fiber. The provider that
 * the location is routed to reports its events, and another provider takes
 * over when the routing changes.
 */
export class Watcher {
  private _hooks: Hooks = { change: new Set(), ready: new Set(), error: new Set() }
  private _ready = false
  private _closed = false

  /** Ends the watch. */
  dispose: () => Promise<void>

  /**
   * The shape this watch was registered for, frozen at registration by the one
   * `stat` the constructor takes. A watch follows the shape it started with, so
   * a caller that needs to know which one it got reads it here rather than
   * re-deriving it from the location.
   */
  public readonly shape: 'file' | 'dir'

  /**
   * The type the location has now, read with one `stat`; `undefined` when it
   * cannot be read at all -- a missing entry, a symlink loop, a permission
   * wall, a dropped mount. The three answers are distinct on purpose: `file`
   * has to be tellable from `undefined`, or a watch registered for a directory
   * could never say that its location became a file.
   *
   * `throwIfNoEntry: false` only covers `ENOENT` and `ENOTDIR`; the rest still
   * raise, and a constructor that lets them out takes `ctx.fs.watch()` down
   * before it can report anything.
   */
  private statShape(): 'file' | 'dir' | undefined {
    // The provider owns the reading: this package is the surface every backend
    // shares, and a backend that is not Node has no `node:fs` to stat with. No
    // reader therefore means "cannot tell", which `stale` answers as not stale.
    return this._readShape?.(this.url)
  }

  /**
   * Whether the entry is no longer the shape above: the location is there, of
   * another type, so the watch cannot follow it and stays silent until the
   * entry is that shape again.
   *
   * A silent watch cannot be told from a watch with nothing to report, so the
   * change has to be askable -- and it reads the location instead of
   * remembering an event, because which event reports a shape change differs
   * by platform. The same holds the other way round, where a directory watch
   * loses its location to a file.
   *
   * A location that is *gone* answers `false` as well: this reports a shape
   * mismatch, not whether the watch still fires. A deleted root already
   * differs by platform -- Linux goes silent while the other two keep
   * reporting -- so it is not folded into a shape change here.
   *
   * Computed from one `stat` per read, not remembered from the events that
   * arrive. Which event reports a shape change is not the same on every
   * platform -- measured, macOS does not report `change` when a directory
   * becomes a file again -- so a remembered flag both misses changes and,
   * worse, invents them from the event name. A read costs one `stat`, and none
   * is paid until someone asks.
   *
   * A query about state must not throw: unreadable is answered as "not stale",
   * so a caller writing `if (watch.stale)` never gets an exception instead of
   * a boolean.
   */
  get stale(): boolean {
    const actual = this.statShape()
    if (!actual) return false
    return actual !== this.shape
  }

  /** `connect` starts serving the watch, and returns a function that disposes it. */
  constructor(
    private ctx: Context,
    public url: URL,
    public options: WatchOptions,
    connect: (watcher: Watcher) => () => Promise<void>,
    private _readShape?: (url: URL) => 'file' | 'dir' | undefined,
  ) {
    // A location that cannot be read takes file shape, so a watch on a path
    // that is not there yet follows the file it may become.
    this.shape = this.statShape() === 'dir' ? 'dir' : 'file'
    this.dispose = ctx.effect(() => {
      const disconnect = connect(this)
      return () => {
        this._closed = true
        return disconnect()
      }
    }, 'ctx.fs.watch()')
  }

  /** Adds a listener, and returns a function that removes it. */
  on<K extends keyof WatchEvents>(name: K, listener: WatchEvents[K]): () => void {
    const hooks = this._hooks[name] as Set<Hook<WatchEvents[K]>>
    const hook: Hook<WatchEvents[K]> = { listener }
    hooks.add(hook)
    if (name === 'ready' && this._ready) {
      // asynchronously, as a listener added before the scan is done
      queueMicrotask(() => {
        if (!hook.removed) this._call(listener, [])
      })
    }
    return () => {
      hook.removed = true
      hooks.delete(hook)
    }
  }

  /**
   * Reports an event, as the provider that serves the watch does. Only the
   * first `ready` is dispatched, so a provider that takes over the watch does
   * not report it again.
   */
  emit<K extends keyof WatchEvents>(name: K, ...args: Parameters<WatchEvents[K]>) {
    if (this._closed) return
    if (name === 'error') return this._error(args[0])
    if (name === 'ready') {
      if (this._ready) return
      this._ready = true
    }
    this._dispatch(name, args)
  }

  // An event reaches the hooks taken when it is dispatched.
  private _dispatch(name: keyof WatchEvents, args: any[]) {
    for (const hook of [...this._hooks[name]]) {
      if (!hook.removed) this._call(hook.listener, args)
    }
  }

  private _call(listener: (...args: any[]) => Awaitable<void>, args: any[]) {
    (async () => listener(...args))().catch(error => this._error(error))
  }

  private _error(error: unknown) {
    if (this._closed) return
    const hooks = this._hooks.error
    if (!hooks.size) return this.ctx.logger.warn(error)
    for (const hook of [...hooks]) {
      if (hook.removed) continue
      // an error of an error listener is not dispatched again
      (async () => hook.listener(error))().catch(error => this.ctx.logger.warn(error))
    }
  }
}
