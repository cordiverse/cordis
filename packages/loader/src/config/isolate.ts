import { Context } from 'cordis'
import { Dict } from 'cosmokit'
import type { Entry } from './entry.ts'
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

/**
 * Whether `table` resolves `name` through `boundary`, that is, `boundary` is
 * in the prototype chain of `table` and no table between them maps `name`.
 */
function within(table: Dict<symbol> | null, boundary: Dict<symbol>, name: string) {
  while (table) {
    if (table === boundary) return true
    if (Object.hasOwn(table, name)) return false
    table = Object.getPrototypeOf(table)
  }
  return false
}

/**
 * Apply the isolation of an entry to its context. `next` reloads the entry
 * in the new isolation, after which the impls that move with the entry are
 * transferred and the affected fibers are notified.
 */
export async function patchIsolate(entry: Entry, next: () => Promise<void>) {
  // step 1: generate new isolate map
  const newMap: Dict<symbol> = Object.create(entry.parent.ctx[Context.isolate])
  for (const [name, label] of Object.entries(entry.options.isolate ?? {})) {
    newMap[name] = label === true
      ? (entry.realm ??= new LocalRealm(entry)).access(name)
      : accessGlobal(name, label)
  }

  // step 2: generate service diff
  // `inside`: whether the provider resolves the name through the entry
  const diff: Dict<[symbol, symbol, boolean]> = Object.create(null)
  const oldMap = entry.ctx[Context.isolate]
  // `for...in` includes the names inherited from the old and new parents
  const names = new Set<string>()
  for (const name in oldMap) names.add(name)
  for (const name in newMap) names.add(name)
  for (const name of names) {
    if (newMap[name] === oldMap[name]) continue
    for (const symbol of [oldMap[name], newMap[name]]) {
      const impl = symbol && entry.ctx.reflect.store[symbol]
      if (!impl) continue
      if (!impl.ctx.fiber) {
        entry.ctx.logger.warn(new Error(`expected service ${name} to be implemented`))
        continue
      }
      // the provision context, which may isolate the name apart from its fiber
      const inside = within(impl.ctx[Context.isolate], oldMap, name)
      diff[name] = [oldMap[name], newMap[name], inside]
      if (!inside) break
    }
  }

  // step 3: set prototype for transferred context
  Object.setPrototypeOf(entry.ctx[Context.isolate], entry.parent.ctx[Context.isolate])
  swap(entry.ctx[Context.isolate], newMap)

  // step 4: reload fiber
  await next()

  // step 5: replace service impl
  for (const [symbol1, symbol2, inside] of Object.values(diff)) {
    const impl = entry.ctx.reflect.store[symbol1]
    if (inside && impl && !entry.ctx.reflect.store[symbol2]) {
      entry.ctx.reflect.store[symbol2] = impl
      delete entry.ctx.reflect.store[symbol1]
      impl.isolate = symbol2
    }
  }

  // step 6: reflect notify
  // The fibers on each side of the move are notified from a context that
  // resolves the names to that side, which reports the service of that side.
  // The entry's isolate map is swapped in place, so `oldMap` is still the
  // boundary; a context is affected if it lies on the other side of it.
  for (const side of [0, 1] as const) {
    let notifier = entry.ctx
    for (const [name, symbols] of Object.entries(diff)) {
      if (symbols[side]) notifier = notifier.isolate(name, symbols[side])
    }
    notifier.reflect.notify(Object.keys(diff), (ctx, name) => {
      const [, , inside] = diff[name]
      const symbol = diff[name][side]
      return !!symbol && ctx[Context.isolate][name] === symbol && within(ctx[Context.isolate], oldMap, name) !== inside
    })
  }
}
