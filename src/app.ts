import { Context } from './context'
import { Lifecycle } from './lifecycle'
import { Registry } from './plugin'

export class App extends Context {
  options: App.Config
  counter = 0

  constructor(config?: App.Config) {
    super({ filter: () => true, mapping: Object.create(null) } as any)
    this.app = this
    this.options = Registry.validate(App, config)
    for (const key of Object.getOwnPropertySymbols(Context.internal)) {
      this[key] = new Context.internal[key](this, this.options)
    }
  }

  start() {
    return this.lifecycle.start()
  }

  stop() {
    return this.lifecycle.stop()
  }
}

export namespace App {
  export interface Config extends Lifecycle.Config, Registry.Config {}
}
