import { Context } from 'cordis'

declare const ctx: Context

ctx.on('internal/listener', (name, listener, options) => {
  if (typeof name === 'symbol') {
    name.description
  }

  listener
  options.prepend
  options.global
})
