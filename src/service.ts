import { Awaitable, defineProperty } from 'cosmokit'
import { Context } from './context'

export namespace Service {
  export interface Options {
    delegates?: string[]
  }
}

export class Service {
  protected start(): Awaitable<void> {}
  protected stop(): Awaitable<void> {}

  constructor(protected ctx: Context, public name: string, public immediate?: boolean) {
    Service.register(Object.getPrototypeOf(ctx), name)

    ctx.lifecycle.on('ready', async () => {
      await this.start()
      if (!immediate) ctx[name] = this
    })

    if (immediate) {
      setTimeout(() => ctx[name] = this, 0)
    }

    ctx.lifecycle.on('dispose', async () => {
      if (ctx[name] === this) ctx[name] = null
      await this.stop()
    })
  }

  get caller(): Context {
    return this[Context.current] || this.ctx
  }

  static register(prototype: Context, key: string) {
    if (Object.prototype.hasOwnProperty.call(prototype, key)) return
    // Services.push(key)
    const privateKey = Symbol(key)
    Object.defineProperty(prototype, key, {
      get(this: Context) {
        const value = this.root[privateKey]
        if (!value) return
        defineProperty(value, Context.current, this)
        return value
      },
      set(this: Context, value) {
        const oldValue = this.root[privateKey]
        if (oldValue === value) return
        this.root[privateKey] = value
        this.lifecycle.emit('service', key)
        const action = value ? oldValue ? 'changed' : 'enabled' : 'disabled'
        this.logger('service').debug(key, action)
      },
    })
    return privateKey
  }
}

Service.register(Context.prototype, 'lifecycle')
Service.register(Context.prototype, 'registry')
