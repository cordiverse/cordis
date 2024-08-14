import { access, constants, readFile, rename, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { remove } from 'cosmokit'
import * as yaml from 'js-yaml'
import { EntryOptions } from './entry.ts'
import { Loader } from '../loader.ts'
import { JsExpr } from './utils.ts'

export const schema = yaml.JSON_SCHEMA.extend(JsExpr)

export class LoaderFile {
  public suspend = false
  public readonly: boolean
  public refs: FileRef[] = []
  public writeTask?: NodeJS.Timeout

  constructor(public loader: Loader, public name: string, public type?: string) {
    this.readonly = !type
  }

  async checkAccess() {
    if (!this.type) return
    try {
      await access(this.name, constants.W_OK)
    } catch {
      this.readonly = true
    }
  }

  async read(): Promise<EntryOptions[]> {
    if (this.type === 'application/yaml') {
      return yaml.load(await readFile(this.name, 'utf8'), { schema }) as any
    } else if (this.type === 'application/json') {
      // we do not use require / import here because it will pollute cache
      return JSON.parse(await readFile(this.name, 'utf8')) as any
    } else {
      const module = await import(this.name)
      return module.default || module
    }
  }

  private async _write(config: EntryOptions[]) {
    this.suspend = true
    if (this.readonly) {
      throw new Error(`cannot overwrite readonly config`)
    }
    if (this.type === 'application/yaml') {
      await writeFile(this.name + '.tmp', yaml.dump(config, { schema }))
    } else if (this.type === 'application/json') {
      await writeFile(this.name + '.tmp', JSON.stringify(config, null, 2))
    }
    await rename(this.name + '.tmp', this.name)
  }

  write(config: EntryOptions[]) {
    clearTimeout(this.writeTask)
    this.writeTask = setTimeout(() => {
      this.writeTask = undefined
      this._write(config)
    }, 0)
  }

  ref() {
    return new FileRef(this)
  }
}

export namespace LoaderFile {
  export const writable = {
    '.json': 'application/json',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
  }

  export const supported = new Set(Object.keys(writable))

  if (typeof require !== 'undefined') {
    // eslint-disable-next-line n/no-deprecated-api
    for (const extname in require.extensions) {
      supported.add(extname)
    }
  }
}

export class FileRef<F extends LoaderFile = LoaderFile> {
  public url: string

  constructor(public file: F) {
    this.file.refs.push(this)
    this.url = pathToFileURL(file.name).href
    file.loader.files[this.url] ??= this.file
  }

  stop() {
    remove(this.file.refs, this)
    if (this.file.refs.length) return
    delete this.file.loader.files[this.url]
  }
}
