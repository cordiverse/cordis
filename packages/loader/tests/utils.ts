import { Dict } from 'cosmokit'
import { Context, Plugin } from '@cordisjs/core'
import { group, Loader } from '../src/shared'

declare module '../src/shared' {
  interface Loader {
    register(name: string, plugin: any): void
  }
}

export default class MockLoader extends Loader {
  public data: Dict<Plugin.Object> = Object.create(null)

  constructor(ctx: Context) {
    super(ctx, { name: 'cordis' })
    this.register('cordis/group', group)
    this.writable = true
  }

  register(name: string, plugin: any) {
    this.data[name] = plugin
  }

  async import(name: string) {
    return this.data[name]
  }

  async readConfig() {
    return this.config
  }
}
