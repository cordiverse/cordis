import { Context } from 'cordis'

declare module 'cordis' {
  interface Events {
    'test/config'(tag: string): any
    'test/running'(tags: string[]): void
  }
}

export const name = 'config-component'

/** Tags of every apply, in order, so tests can count restarts. */
export const applied: string[] = []

export function apply(ctx: Context, config: any) {
  applied.push(config.tag)
  ctx.on('test/config', (tag: string) => tag === config.tag ? config : undefined)
  // collects the tag of every running instance
  ctx.on('test/running', (tags: string[]) => tags.push(config.tag))
}
