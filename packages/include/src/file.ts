import { access, constants, readFile, rename, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { remove } from 'cosmokit'
import * as yaml from 'js-yaml'
import { EntryOptions, EntryTree, isJsExpr } from '@cordisjs/plugin-loader'

export const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data['__jsExpr'],
})

export const schema = yaml.JSON_SCHEMA.extend(JsExpr)

export class ConfigFile {
  public readonly: boolean
  public trees: EntryTree[] = []
  public writeTask?: NodeJS.Timeout
  public content?: string
  public data?: EntryOptions[]

  constructor(public name: string, public type?: string) {
    this.readonly = !type
  }

  ref(tree: EntryTree) {
    this.trees.push(tree)
    tree.ctx.baseUrl = pathToFileURL(this.name).href
  }

  unref(tree: EntryTree) {
    remove(this.trees, tree)
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

export namespace ConfigFile {
  export const writable: Record<string, string> = {
    '.json': 'application/json',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
  }

  export const supported = new Set(Object.keys(writable))
}
