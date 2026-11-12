import { Context } from 'cordis'
import { Dict } from 'cosmokit'
import { Entry } from './entry.ts'
import { swap } from './utils.ts'

declare module './entry.ts' {
  interface EntryOptions {
    isolate?: Dict<true | string> | null
  }

  interface Entry {
    realm: LocalRealm
  }
}

export class LocalRealm {
  private store: Dict<symbol> = Object.create(null)

  constructor(private entry: Entry) {}

  access(key: string) {
    return this.store[key] ??= Symbol(`${key}#${this.entry.options.id}`)
  }
}

/** The symbol of a service in a global realm, shared by every entry with the same label. */
export function accessGlobal(key: string, label: string) {
  return Symbol.for(`cordis:isolate:${JSON.stringify([key, label])}`)
}

export default function isolate(ctx: Context) {
  const delims: Dict<symbol> = Object.create(null)

  ctx.on('loader/entry-init', (entry) => {
    entry.ctx[Context.isolate] = Object.create(entry.ctx[Context.isolate])
  })

  ctx.on('loader/patch-context', async (entry, next) => {
    // step 1: generate new isolate map
    const newMap: Dict<symbol> = Object.create(entry.parent.ctx[Context.isolate])
    for (const [name, label] of Object.entries(entry.options.isolate ?? {})) {
      newMap[name] = label === true
        ? (entry.realm ??= new LocalRealm(entry)).access(name)
        : accessGlobal(name, label)
    }

    // step 2: generate service diff
    const diff: Dict<[symbol, symbol, symbol, symbol]> = Object.create(null)
    const oldMap = entry.ctx[Context.isolate]
    for (const name in { ...newMap, ...delims }) {
      if (newMap[name] === oldMap[name]) continue
      const delim = delims[name] ??= Symbol(`delim:${name}`)
      entry.ctx[delim] = Symbol(`${name}#${entry.id}`)
      for (const symbol of [oldMap[name], newMap[name]]) {
        const impl = symbol && entry.ctx.reflect.store[symbol]
        if (!impl) continue
        const fiber = impl.ctx.fiber
        if (!fiber) {
          entry.ctx.logger.warn(new Error(`expected service ${name} to be implemented`))
          continue
        }
        diff[name] = [oldMap[name], newMap[name], entry.ctx[delim], fiber.ctx[delim]]
        if (entry.ctx[delim] !== fiber.ctx[delim]) break
      }
    }

    // step 3: set prototype for transferred context
    Object.setPrototypeOf(entry.ctx[Context.isolate], entry.parent.ctx[Context.isolate])
    swap(entry.ctx[Context.isolate], newMap)

    // step 4: reload fiber
    await next()

    // step 5: replace service impl
    for (const [symbol1, symbol2, flag1, flag2] of Object.values(diff)) {
      const impl = entry.ctx.reflect.store[symbol1]
      if (flag1 === flag2 && impl && !entry.ctx.reflect.store[symbol2]) {
        entry.ctx.reflect.store[symbol2] = impl
        delete entry.ctx.reflect.store[symbol1]
        impl.isolate = symbol2
      }
    }

    // step 6: reflect notify
    ctx.reflect.notify(Object.keys(diff), (ctx, name) => {
      const [symbol1, symbol2, flag1, flag2] = diff[name]
      const symbol3 = ctx[Context.isolate][name]
      const flag3 = ctx[delims[name]]
      return (symbol1 === symbol3 || symbol2 === symbol3) && (flag1 === flag3) !== (flag1 === flag2)
    })

    // step 7: clean up delimiters
    for (const name in delims) {
      if (!Reflect.ownKeys(newMap).includes(name)) {
        delete entry.ctx[delims[name]]
      }
    }
  })
}
