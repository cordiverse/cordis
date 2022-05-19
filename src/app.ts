import { Context } from './context'
import { Lifecycle } from './lifecycle'
import { Registry } from './plugin'

export class App extends Context {
  options: App.Config

  constructor(config?: App.Config) {
    super(() => true, null, null)
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
