import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

async function readOptional(path: string) {
  try {
    return await readFile(path)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export class FileBackup {
  private constructor(private files: Map<string, Buffer | null>) {}

  static async create(paths: Iterable<string>) {
    const files = new Map<string, Buffer | null>()
    for (const path of paths) files.set(path, await readOptional(path))
    return new FileBackup(files)
  }

  async restore() {
    for (const [path, content] of this.files) {
      if (content === null) {
        await rm(path, { force: true })
        continue
      }
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, content)
      await rename(temp, path)
    }
  }
}
