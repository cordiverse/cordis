import { createFilter, Watcher } from '@cordisjs/fs'
import { watch } from 'chokidar'
import { statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Serves `watcher` at `filename` through chokidar, and returns a function that stops it. */
export function watchPath(watcher: Watcher, filename: string) {
  const keep = watcher.options.filter && createFilter(watcher.options.filter)
  // A file replaced through a rename, as by an atomic write, is lost by a
  // watch on the file itself, so its directory is watched instead.
  const isFile = !statSync(filename, { throwIfNoEntry: false })?.isDirectory()
  const root = isFile ? dirname(filename) : filename
  const instance = watch(root, {
    ignoreInitial: true,
    depth: isFile ? 0 : undefined,
    // chokidar also tests the root itself
    ignored: (path, stats) => {
      path = resolve(path)
      if (path === root) return false
      if (isFile) return path !== filename
      if (!keep) return false
      // Without the stats, or with the `lstat()` of a symbolic link, the type
      // is unknown, so the entry is kept; chokidar tests it again with the
      // stats of `stat()` before it is watched.
      if (!stats || stats.isSymbolicLink()) return false
      return !keep(relative(root, path).split(sep).join('/'), stats.isDirectory())
    },
  })
  instance.on('error', error => watcher.emit('error', error))
  instance.on('change', path => watcher.emit('change', pathToFileURL(resolve(path))))
  instance.once('ready', () => watcher.emit('ready'))
  // `close()` removes the listeners at once.
  return () => instance.close()
}
