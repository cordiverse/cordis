import { Context } from 'cordis'
import { Awaitable } from 'cosmokit'

export type WatchFilter = string[] | ((path: string, isDirectory: boolean) => boolean)

export interface WatchOptions {
  /**
   * Decides which entries below a watched directory are kept. An array holds
   * glob patterns, matched by `@cordisjs/fs-node` against the path relative to
   * the watched directory with `/` as the separator. The last pattern that
   * matches an entry or one of its ancestors decides, and a pattern starting
   * with `!` means the entry is not kept.
   */
  filter?: WatchFilter
}

export interface WatchEvents {
  /** A file at or below the watched location is modified. */
  change(url: URL): Awaitable<void>
  /**
   * The initial scan is done. A listener added afterwards is called on the next
   * microtask, not on the line that adds it.
   */
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

  /** `connect` starts serving the watch, and returns a function that disposes it. */
  constructor(
    private ctx: Context,
    public url: URL,
    public options: WatchOptions,
    connect: (watcher: Watcher) => () => Promise<void>,
  ) {
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
