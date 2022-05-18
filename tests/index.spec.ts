import { Context } from '../src'

declare module '../src' {
  interface Events {
    'foo'(): void
  }
}

const ctx = Context.create()

function plugin(ctx: Context, { text }: { text: string }) {
  ctx.lifecycle.on('foo', () => {
    console.log(text)
  })
}

ctx.intersect(() => false).lifecycle.on('foo', () => {
  console.log('foo')
})

ctx.plugin(plugin, { text: 'bar' })

ctx.lifecycle.emit({}, 'foo')
