import { App, Context } from '../src'

declare module '../src' {
  interface Events {
    'foo'(): void
  }
}

const ctx = new App()

function plugin(ctx: Context, { text }: { text: string }) {
  ctx.on('foo', () => {
    console.log(text)
  })
}

ctx.intersect(() => false).on('foo', () => {
  console.log('foo')
})

ctx.plugin(plugin, { text: 'bar' })

ctx.emit({}, 'foo')
