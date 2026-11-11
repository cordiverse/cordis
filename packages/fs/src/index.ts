import { Context, Service } from 'cordis'
import { FsError } from './error.ts'
import { resolvePath } from './path.ts'
import { kAbort, kStart } from './symbols.ts'
import { Watcher, WatchOptions } from './watcher.ts'

export * from './error.ts'
export * from './watcher.ts'

declare module 'cordis' {
  interface Context {
    fs: Fs
  }
}

// at least two characters, so that a drive letter is not a scheme
const scheme = /^[a-zA-Z][a-zA-Z\d+.-]+:/

interface Mount {
  /** a scheme such as `s3:`, or a URL ending with `/` */
  prefix: string
  provider: FsProvider
  watches: Set<Watcher>
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

  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /**
   * Mount a provider at a scheme, such as `s3:`, or at a URL, such as
   * `file:///`. A location goes to the provider of the longest prefix that
   * contains it. The mount and the watches of its provider end with the calling
   * fiber.
   */
  mount(prefix: string | URL, provider: FsProvider) {
    const key = normalizePrefix(prefix)
    return this.ctx.effect(() => {
      if (this._mounts.has(key)) {
        throw new Error(`a provider is already mounted at ${key}`)
      }
      const mount: Mount = { prefix: key, provider, watches: new Set() }
      this._mounts.set(key, mount)
      return async () => {
        this._mounts.delete(key)
        const watches = [...mount.watches]
        mount.watches.clear()
        await Promise.all(watches.map((watcher) => {
          return watcher[kAbort](new FsError('NoProvider', watcher.url, `the provider mounted at ${key} is disposed`))
        }))
      }
    }, 'ctx.fs.mount()')
  }

  /** A string with a scheme is taken as a URL, and any other string as a path. */
  private _resolve(path: string | URL): URL {
    if (path instanceof URL) return path
    if (scheme.test(path)) return new URL(path)
    return resolvePath(path, this.ctx.baseUrl)
  }

  private _route(url: URL): Mount {
    let result: Mount | undefined
    for (const mount of this._mounts.values()) {
      const matches = mount.prefix.endsWith(':')
        ? url.protocol === mount.prefix
        : url.href.startsWith(mount.prefix) || url.href + '/' === mount.prefix
      if (matches && (!result || mount.prefix.length > result.prefix.length)) result = mount
    }
    if (!result) throw new FsError('NoProvider', url, `no provider is mounted for ${url.href}`)
    return result
  }

  /** Watch a file or a directory. The watch ends with the calling fiber. */
  watch(path: string | URL, options: WatchOptions = {}): Watcher {
    const url = this._resolve(path)
    const mount = this._route(url)
    const { provider } = mount
    if (!provider.watch) {
      throw new FsError('NotSupported', url, `the provider mounted at ${mount.prefix} does not support watch()`)
    }
    const watcher = provider.watch(this.ctx, url, options)
    watcher[kStart](() => mount.watches.delete(watcher))
    mount.watches.add(watcher)
    return watcher
  }
}

export interface FsProvider {
  /** Create a watch, which the service starts on the calling fiber. */
  watch?(ctx: Context, url: URL, options: WatchOptions): Watcher
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
