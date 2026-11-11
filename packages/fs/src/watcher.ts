import { Context } from 'cordis'
import { Awaitable } from 'cosmokit'
import { kAbort, kStart } from './symbols.ts'

export type WatchFilter = string[] | ((path: string, isDirectory: boolean) => boolean)

export interface WatchOptions {
  /**
   * Decides which entries below a watched directory are kept.
   */
  filter?: WatchFilter
}

export interface WatchEvents {
  /** A file below the watched path is modified. */
  change(filename: string): Awaitable<void>
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
 * A watch on a location. A provider implements `_start()` and `_stop()`, and
 * reports through `_emit()` and `_error()`. The constructor runs before the
 * watch starts, so a provider may throw from it.
 */
export abstract class Watcher {
  private _hooks: Hooks = { change: new Set(), ready: new Set(), error: new Set() }
  private _ready = false
  private _closed = false
  private _dispose?: () => Promise<void>

  constructor(protected ctx: Context, public url: URL, protected options: WatchOptions) {}

  /** Resolves once the initial scan is done. */
  protected abstract _start(): Promise<void>
  /** Stops watching. */
  protected abstract _stop(): Awaitable<void>

  /** Ends the watch. The watch also ends with the calling fiber. */
  dispose(): Promise<void> {
    return this._dispose?.() ?? Promise.resolve()
  }

  [kStart](onStop: () => void) {
    this._dispose = this.ctx.effect(() => {
      this._start().then(() => {
        if (this._closed) return
        this._ready = true
        this._emit('ready')
      }, error => this._error(error))
      return async () => {
        this._closed = true
        onStop()
        await this._stop()
      }
    }, 'ctx.fs.watch()')
  }

  /** Ends the watch with an error, e.g. when its provider is unmounted. */
  [kAbort](error: unknown) {
    this._error(error)
    return this.dispose()
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

  // An event reaches the hooks taken when it is dispatched.
  protected _emit<K extends keyof WatchEvents>(name: K, ...args: Parameters<WatchEvents[K]>) {
    if (this._closed) return
    for (const hook of [...this._hooks[name]]) {
      if (!hook.removed) this._call(hook.listener, args)
    }
  }

  private _call(listener: (...args: any[]) => Awaitable<void>, args: any[]) {
    (async () => listener(...args))().catch(error => this._error(error))
  }

  protected _error(error: unknown) {
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
