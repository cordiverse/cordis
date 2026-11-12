import { BaseFs, Watcher } from '@cordisjs/fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { watchPath } from './watcher.ts'

// `C:` is relative to the current directory of drive C, which depends on the
// process. A separator after the colon names a location.
const driveRelative = /^[a-zA-Z]:(?![\\/])/

function toPath(url: URL) {
  const filename = fileURLToPath(url)
  // checked before `resolve()`, which makes a drive-relative path absolute
  if (process.platform === 'win32' && driveRelative.test(filename)) {
    throw new TypeError(
      `expected an absolute path, got the drive-relative form ${JSON.stringify(filename)} from ${JSON.stringify(url.href)}`,
    )
  }
  // `fileURLToPath()` keeps a trailing slash
  return resolve(filename)
}

/** The local file system of Node.js. */
class NodeFs extends BaseFs {
  static mount = 'file:'

  watch(watcher: Watcher) {
    return watchPath(watcher, toPath(watcher.url))
  }
}

export default NodeFs
