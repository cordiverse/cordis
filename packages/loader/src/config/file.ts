import { access, constants, readFile, rename, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { remove } from 'cosmokit'
import * as yaml from 'js-yaml'
import { EntryOptions } from './entry.ts'
import { ImportTree } from './import.ts'
import { JsExpr } from './utils.ts'

export const schema = yaml.JSON_SCHEMA.extend(JsExpr)

export class LoaderFile {
  public suspend = false
  public readonly: boolean
  public trees: ImportTree[] = []
  public writeTask?: NodeJS.Timeout

  constructor(public name: string, public type?: string) {
    this.readonly = !type
  }

  ref(tree: ImportTree) {
    this.trees.push(tree)
    tree.url = pathToFileURL(this.name).href
    tree.ctx.loader.files[tree.url] ??= this
  }

  unref(tree: ImportTree) {
    remove(this.trees, tree)
    if (this.trees.length) return
    delete tree.ctx.loader.files[tree.url]
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
