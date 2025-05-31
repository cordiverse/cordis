import { access, constants, readFile, rename, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { remove } from 'cosmokit'
import * as yaml from 'js-yaml'
import { EntryOptions } from './entry.ts'
import { ImportTree } from './import.ts'
import { JsExpr } from './utils.ts'
import { dirname } from 'node:path'

export const schema = yaml.JSON_SCHEMA.extend(JsExpr)

export class LoaderFile {
  public readonly: boolean
  public trees: ImportTree[] = []
  public writeTask?: NodeJS.Timeout
  public content?: string
  public data?: EntryOptions[]

  constructor(public name: string, public type?: string) {
    this.readonly = !type
  }

  ref(tree: ImportTree) {
    this.trees.push(tree)
    tree.url = pathToFileURL(this.name).href
    tree.ctx.loader.files[tree.url] ??= this
    // use defineProperty to prevent provide check
    Object.defineProperty(tree.ctx, 'baseDir', {
      value: dirname(this.name),
      configurable: true,
    })
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

  async read(forced = false) {
    const content = await readFile(this.name, 'utf8')
    if (!forced && this.content === content) return false
    this.content = content
    if (this.type === 'application/yaml') {
      this.data = yaml.load(this.content, { schema }) as any
    } else if (this.type === 'application/json') {
      // we do not use require / import here because it will pollute cache
      this.data = JSON.parse(this.content) as any
    } else {
      const module = await import(this.name)
      this.data = module.default || module
    }
    await this.checkAccess()
    return true
  }

  async refresh() {
    if (!await this.read()) return
    for (const tree of this.trees) {
      await tree.root.update(this.data!)
    }
  }

  private async _write(config: EntryOptions[]) {
    if (this.readonly) {
      throw new Error(`cannot overwrite readonly config`)
    }
    if (this.type === 'application/yaml') {
      this.content = yaml.dump(config, { schema })
    } else if (this.type === 'application/json') {
      this.content = JSON.stringify(config, null, 2)
    }
    await writeFile(this.name + '.tmp', this.content!)
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
}
