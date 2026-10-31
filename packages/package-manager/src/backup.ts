import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

interface Snapshot {
  link?: string
  /** absent for a dangling link */
  content?: Buffer
  mode?: number
}

function isMissing(error: any) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}

async function snapshot(path: string): Promise<Snapshot | undefined> {
  let link: string | undefined
  try {
    if ((await lstat(path)).isSymbolicLink()) link = await readlink(path)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  try {
    const [content, stats] = await Promise.all([readFile(path), stat(path)])
    return { link, content, mode: stats.mode & 0o7777 }
  } catch (error) {
    if (link !== undefined && isMissing(error)) return { link }
    throw error
  }
}

export class FileBackup {
  private constructor(private files: Map<string, Snapshot | undefined>) {}

  static async create(paths: Iterable<string>) {
    const files = new Map<string, Snapshot | undefined>()
    for (const path of paths) files.set(path, await snapshot(path))
    return new FileBackup(files)
  }

  async restore() {
    for (const [path, file] of this.files) {
      if (!file) {
        await rm(path, { force: true })
        continue
      }
      let target = path
      if (file.link !== undefined) {
        if (await readlink(path).catch(() => undefined) !== file.link) {
          await rm(path, { force: true })
          await symlink(file.link, path)
        }
        if (!file.content) continue
        target = await realpath(path).catch(() => resolve(dirname(path), file.link!))
      }
      await mkdir(dirname(target), { recursive: true })
      const temp = `${target}.${process.pid}.tmp`
      // The mode applies on creation, so that the content is never more
      // readable than before; `chmod` restores the bits that umask removes.
      await writeFile(temp, file.content!, { mode: file.mode })
      await chmod(temp, file.mode!)
      await rename(temp, target)
    }
  }
}
