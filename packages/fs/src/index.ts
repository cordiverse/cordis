import { Context, Service } from 'cordis'
import { Awaitable } from 'cosmokit'
import { FsError } from './error.ts'
import { Watcher, WatchOptions } from './watcher.ts'

export * from './error.ts'
export * from './watcher.ts'

declare module 'cordis' {
  interface Context {
    fs: Fs
  }
}

interface Mount {
  /** a scheme such as `s3:`, or a URL ending with `/` */
  prefix: string
  provider: FsProvider
}

// a watch served by the provider of a mount
interface Connection {
  mount: Mount
  dispose: () => Awaitable<void>
}

function normalizePrefix(prefix: string | URL) {
  if (typeof prefix === 'string' && /^[a-zA-Z][a-zA-Z\d+.-]*:$/.test(prefix)) {
    return prefix.toLowerCase()
  }
  const { href } = new URL(prefix)
  return href.endsWith('/') ? href : href + '/'
}

/**
 * The file system service, which forwards each operation to the provider
 * mounted at its location.
 */
export class Fs extends Service {
  private _mounts = new Map<string, Mount>()
  /** the connection that serves each watch, if any */
  private _watchers = new Map<Watcher, Connection | undefined>()

  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /**
   * Mount a provider at a scheme, such as `s3:`, or at a URL, such as
   * `file:///`. A location goes to the provider of the longest prefix that
   * contains it. The mount ends with the calling fiber.
   *
   * Every watch follows the routing: a change of the mounts moves it to the
   * provider its location goes to, and a watch without a provider is resumed
   * once one is mounted. Changes while a watch has no provider are not reported.
   */
  mount(prefix: string | URL, provider: FsProvider) {
    const key = normalizePrefix(prefix)
    return this.ctx.effect(() => {
      if (this._mounts.has(key)) {
        throw new Error(`a provider is already mounted at ${key}`)
      }
      this._mounts.set(key, { prefix: key, provider })
      this._reroute()
      return () => {
        this._mounts.delete(key)
        return this._reroute()
      }
    }, 'ctx.fs.mount()')
  }

  /** Resolve a URL reference against `ctx.baseUrl`. */
  resolve(path: string | URL): URL {
    if (path instanceof URL) return path
    const base = this.ctx.baseUrl
    if (!base && !URL.canParse(path)) {
      throw new TypeError(`cannot resolve the relative reference ${JSON.stringify(path)} without ctx.baseUrl`)
    }
    return new URL(path, base)
  }

  private _match(url: URL): Mount | undefined {
    let result: Mount | undefined
    for (const mount of this._mounts.values()) {
      const matches = mount.prefix.endsWith(':')
        ? url.protocol === mount.prefix
        : url.href.startsWith(mount.prefix) || url.href + '/' === mount.prefix
      if (matches && (!result || mount.prefix.length > result.prefix.length)) result = mount
    }
    return result
  }

  private _route(url: URL): Mount {
    const mount = this._match(url)
    if (!mount) throw new FsError('NoProvider', url, `no provider is mounted for ${url.href}`)
    return mount
  }

  private _connect(watcher: Watcher, mount: Mount) {
    const { provider, prefix } = mount
    if (!provider.watch) {
      throw new FsError('NotSupported', watcher.url, `the provider mounted at ${prefix} does not support watch()`)
    }
    const dispose = provider.watch(watcher)
    this._watchers.set(watcher, { mount, dispose })
  }

  // The provider watch is disposed at once, and reports no more events.
  private async _disconnect(watcher: Watcher) {
    const connection = this._watchers.get(watcher)
    if (!connection) return
    this._watchers.set(watcher, undefined)
    await connection.dispose()
  }

  private _reroute() {
    const stops: Promise<void>[] = []
    for (const [watcher, connection] of this._watchers) {
      const mount = this._match(watcher.url)
      if (mount === connection?.mount) continue
      stops.push(this._disconnect(watcher).catch(error => watcher.emit('error', error)))
      if (!mount) {
        this.ctx.logger.debug('watch of %s is suspended without a provider', watcher.url.href)
        continue
      }
      try {
        this._connect(watcher, mount)
      } catch (error) {
        watcher.emit('error', error)
      }
    }
    return Promise.all(stops).then(() => {})
  }

  /** Watch a file or a directory. The watch ends with the calling fiber. */
  watch(path: string | URL, options: WatchOptions = {}): Watcher {
    const url = this.resolve(path)
    const mount = this._route(url)
    return new Watcher(this.ctx, url, options, (watcher) => {
      this._connect(watcher, mount)
      return async () => {
        const connection = this._watchers.get(watcher)
        this._watchers.delete(watcher)
        await connection?.dispose()
      }
    })
  }
}

export interface FsProvider {
  /**
   * Start serving `watcher`, and return a function that disposes it. The
   * provider reports through `watcher.emit()`, with a `ready` once the initial
   * scan is done, and reports nothing once the returned function is called.
   */
  watch?(watcher: Watcher): () => Awaitable<void>
}

export interface BaseFs extends FsProvider {}

/** A provider that mounts itself, at `config.mount` or at its static `mount`. */
export abstract class BaseFs {
  static inject = ['fs']
  /** The default mount point of the subclass. */
  static mount?: string

  constructor(public ctx: Context, config: BaseFs.Config = {}) {
    const mount = config.mount ?? (new.target as typeof BaseFs).mount
    if (!mount) throw new TypeError('expected a mount point in the config')
    ctx.fs.mount(mount, this)
  }
}

export namespace BaseFs {
  export interface Config {
    /** a scheme such as `s3:`, or a URL such as `file:///` */
    mount?: string
  }
}

export default Fs
