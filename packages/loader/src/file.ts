import { access, constants, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import Loader from './shared.ts'

export class FileLoader<T extends Loader = Loader> {
  public suspend = false
  public mutable = false

  private _writeTask?: NodeJS.Timeout

  constructor(public loader: T, public name: string, public type?: string) {}

  async checkAccess() {
    if (!this.type) return
    try {
      await access(this.name, constants.W_OK)
      this.mutable = true
    } catch {}
  }

  async read() {
    if (this.type === 'application/yaml') {
      return yaml.load(await readFile(this.name, 'utf8')) as any
    } else if (this.type === 'application/json') {
      // we do not use require / import here because it will pollute cache
      return JSON.parse(await readFile(this.name, 'utf8')) as any
    } else {
      const module = await import(this.name)
      return module.default || module
    }
  }

  private async _write(config: any) {
    this.suspend = true
    if (!this.mutable) {
      throw new Error(`cannot overwrite readonly config`)
    }
    if (this.type === 'application/yaml') {
      await writeFile(this.name, yaml.dump(config))
    } else if (this.type === 'application/json') {
      await writeFile(this.name, JSON.stringify(config, null, 2))
    }
  }

  write(config: any) {
    clearTimeout(this._writeTask)
    this._writeTask = setTimeout(() => {
      this._writeTask = undefined
      this._write(config)
    }, 0)
  }

  async import(name: string) {
    if (this.loader.internal) {
      return this.loader.internal.import(name, pathToFileURL(this.name).href, {})
    } else {
      return import(name)
    }
  }
}
