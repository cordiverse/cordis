import { Context } from 'cordis'

export const name = 'schema-plugin'

/** Requires a numeric `port` and reports every issue it finds. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value: any) {
      if (value === undefined) return { issues: [{ message: 'config is required' }] }
      const issues: any[] = []
      if (typeof value.port !== 'number') issues.push({ message: 'port must be a number', path: [{ key: 'port' }] })
      if (value.hosts?.some((host: unknown) => typeof host !== 'string')) {
        const index = value.hosts.findIndex((host: unknown) => typeof host !== 'string')
        issues.push({ message: 'host must be a string', path: ['hosts', index] })
      }
      return issues.length ? { issues } : { value }
    },
  },
}

export function apply(ctx: Context, config: any) {
  ctx.on('test/config', (tag: string) => tag === config.tag ? config : undefined)
}
