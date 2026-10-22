import { Context, Service } from 'cordis'
import { Awaitable } from 'cosmokit'
import { ChokidarOptions, FSWatcher, watch } from 'chokidar'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import picomatch from 'picomatch'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import z from 'schemastery'

// A Windows drive-letter path, e.g. `C:\app\cordis.yml` or `C:/app/cordis.yml`.
const driveLetter = /^[A-Za-z]:[\\/]/

declare module 'cordis' {
  interface Context {
    fs: FileSystem
  }

  interface Events {
    'fs/change'(filename: string): void
  }
}

export type WatchCallback = () => Awaitable<void>

/**
 * The file system service. For now it only watches files, backed by
 * `node:fs` through chokidar.
 *
 * On a change, the callbacks registered for the file through `watch()` run
 * first, and `fs/change` is emitted once they have settled.
 */
class FileSystem extends Service {
  public baseDir: string

  private _watcher!: FSWatcher

  /** Callbacks registered through `watch()`, keyed by absolute path. */
  private _callbacks = new Map<string, Set<WatchCallback>>()

  constructor(ctx: Context, public config: FileSystem.Config) {
    super(ctx, 'fs')
    // On Windows, a drive-letter path is converted with `pathToFileURL`.
    // `new URL()` would read its `C:` as a URL scheme, which `fileURLToPath` rejects.
    // Without a `baseUrl`, file URLs are still decoded as URLs; ordinary
    // paths are resolved against the working directory.
    this.baseDir = process.platform === 'win32' && config.base && driveLetter.test(config.base)
      ? fileURLToPath(pathToFileURL(config.base))
      : ctx.baseUrl || config.base?.startsWith('file:')
        ? fileURLToPath(new URL(config.base || '.', ctx.baseUrl))
        : resolve(config.base || '.')
  }

  async* [Service.init]() {
    yield () => this._watcher?.close()

    const { root, ignored } = this.config
    if (!this.config.base) {
      this.ctx.logger.info('watching %o', root)
    } else {
      this.ctx.logger.info('watching %o in %s', root, this.baseDir)
    }

    const match = picomatch(ignored)
    this._watcher = watch(root, {
      ...this.config,
      cwd: this.baseDir,
      // picomatch only splits on `/`, so a Windows path is converted before matching.
      ignored: path => !this._callbacks.has(resolve(this.baseDir, path))
        && match(relative(this.baseDir, path).split(sep).join('/')),
    })

    this._watcher.on('change', async (path) => {
      this.ctx.logger.debug('change detected at %C', path)
      const filename = resolve(this.baseDir, path)

      // Awaited before the event, so that within one change a callback is
      // settled by the time listeners such as HMR see the file.
      const callbacks = this._callbacks.get(filename)
      if (callbacks?.size) {
        await Promise.all([...callbacks].map(async (callback) => {
          try {
            await callback()
          } catch (error) {
            this.ctx.logger.warn(error)
          }
        }))
      }

      this.ctx.emit('fs/change', filename)
    })
  }

  /**
   * Watch a single file. `callback` runs on every change to it.
   *
   * The path is watched even when it lies outside `root` or matches
   * `ignored`. Registrations are not exclusive: every callback registered for
   * a path runs on each change.
   */
  watch(path: string | URL, callback: WatchCallback) {
    const absolute = path instanceof URL || path.startsWith('file:')
      ? fileURLToPath(path)
      : resolve(this.baseDir, path)
    // Chokidar reports paths relative to `cwd`, which the change handler
    // resolves back against `baseDir`. On Windows `relative()` matches case-
    // insensitively, so the key takes the same round trip to agree with it.
    const filename = resolve(this.baseDir, relative(this.baseDir, absolute))
    return this.ctx.effect(() => {
      let callbacks = this._callbacks.get(filename)
      if (!callbacks) this._callbacks.set(filename, callbacks = new Set())
      callbacks.add(callback)
      // The watch set only ever grows: a path handed to `add()` may well have
      // been covered by `root` already, and `unwatch()` would take it out of
      // the normal watch too. Dropping the callback is what ends the watch.
      this._watcher.add(filename)
      return () => {
        callbacks.delete(callback)
        if (!callbacks.size) this._callbacks.delete(filename)
      }
    }, 'ctx.fs.watch()')
  }
}

namespace FileSystem {
  export interface Config extends ChokidarOptions {
    base?: string
    root: string[]
    ignored: string[]
  }

  export const Config: z<Config> = z.object({
    base: z.string(),
    root: z.array(String).role('table').default(['.']),
    ignored: z.array(String).role('table').default([
      '**/node_modules',
      '**/.*',
      'cache',
      'data',
    ]),
  }).i18n({
    'en-US': enUS,
    'zh-CN': zhCN,
  })
}

export default FileSystem
