import { expect, describe, it } from 'vitest'
import { Context } from 'cordis'
import { Group, Loader } from '../src/index.ts'

// A seeded generator builds random configurations — random `inject` shapes,
// literal and expression `disabled` and `intercept`, groups, providers — and
// drives a fixed sequence of updates derived from the seed alone. What it
// asserts is intrinsic to the tree it runs on, so it needs no model of any
// other branch: an entry that nothing reached applies at most once, and
// re-reading the tree exactly as it was just committed applies nothing again.
// Both are consequences of the state being a function of the configuration.

const sleep = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

class ProbeLoader extends Loader {
  data: any[] = []
  modules: any = Object.create(null)
  constructor(ctx: Context) {
    super(ctx)
    ctx.on('internal/get', (ctx: any, prop: string, error: any, next: any) => {
      if (!ctx.fiber.runtime && prop === 'loader') return ctx.get(prop)
      return next()
    })
  }
  commit(change: any) { this.data = this.root.data }
  async read(data: any[]) { this.data = data; await this.root.update(data); await this.await() }
  async import(name: string) {
    if (name === '@cordisjs/plugin-group') return Group
    return this.modules[name]
  }
  mock(name: string, plugin: any) {
    if (!plugin.name) Object.defineProperty(plugin, 'name', { value: name })
    return this.modules[name] = plugin
  }
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A fresh tree per seed: the loader reuses an `Entry` — and its fiber — when an
// id survives a read, so a shared tree would carry one seed's fiber into the
// next and measure two configurations at once.
async function setup() {
  const root = new Context()
  await root.plugin(ProbeLoader)
  const loader = root.loader as any
  const applied: Record<string, number> = Object.create(null)
  const mock = (name: string) => {
    const plugin: any = function (ctx: Context, config: any) {
      // keyed by entry, not by plugin name: a tagged sibling sharing the name
      // would otherwise move the count of an untagged entry
      const id = ctx.fiber.entry?.options?.id ?? name
      applied[id] = (applied[id] ?? 0) + 1
      if (name.startsWith('svc')) {
        ctx.provide(name, { enabled: config?.enabled !== false, value: config?.value ?? 0 })
      }
    }
    Object.defineProperty(plugin, 'name', { value: name })
    return loader.mock(name, plugin)
  }
  for (const n of ['svcA', 'svcB', 'svcC']) mock(n)
  for (const n of ['p1', 'p2', 'p3']) mock(n)
  return { loader, applied }
}

const hasExpr = (value: any): boolean => {
  if (value && typeof value.__jsExpr === 'string') return true
  if (!value || typeof value !== 'object') return false
  return Object.values(value).some(hasExpr)
}

function generate(seed: number) {
  const rand = mulberry32(seed)
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]
  const services = ['svcA', 'svcB', 'svcC']
  const data: any[] = services.map((name, i) => ({
    id: name,
    name,
    config: { enabled: rand() > 0.3, value: i },
  }))

  const count = 2 + Math.floor(rand() * 4)
  const groupChildren: any[] = []
  for (let i = 0; i < count; i++) {
    const id = `e${i}`
    const injectKeys = services.filter(() => rand() > 0.45)
    const entry: any = { id, name: pick(['p1', 'p2', 'p3']) }

    const shape = rand()
    if (shape < 0.2) {
      entry.inject = [...injectKeys]
    } else if (shape < 0.7) {
      entry.inject = {}
      for (const key of injectKeys) {
        if (rand() < 0.3) entry.inject[key] = { __jsExpr: `svcA.value + ${Math.floor(rand() * 10)}` }
        else entry.inject[key] = true
      }
      if (Object.keys(entry.inject).length === 0) delete entry.inject
    }

    const disabledShape = rand()
    if (disabledShape < 0.25) {
      entry.disabled = rand() > 0.5
    } else if (disabledShape < 0.65) {
      const target = injectKeys.length && rand() > 0.5 ? pick(injectKeys) : pick(services)
      entry.disabled = { __jsExpr: `!${target}.enabled` }
    }

    if (rand() < 0.3) {
      const source = injectKeys.length && rand() > 0.5 ? pick(injectKeys) : 'svcC'
      entry.intercept = rand() > 0.5
        ? { p1: { namespace: { __jsExpr: `${source}.value` } } }
        : { p1: { namespace: `v${Math.floor(rand() * 5)}` } }
    }

    if (rand() < 0.25) entry.config = { a: Math.floor(rand() * 3) }
    if (rand() < 0.25) groupChildren.push(entry)
    else data.push(entry)
  }
  if (groupChildren.length) {
    data.push({
      id: 'g',
      name: '@cordisjs/plugin-group',
      group: true,
      inject: services.filter(() => rand() > 0.5),
      disabled: rand() > 0.5 ? undefined : { __jsExpr: '!svcB.enabled' },
      config: groupChildren,
    })
  }
  return { data }
}

function makePlan(seed: number, data: any[]) {
  const rand = mulberry32(seed ^ 0x9e3779b9)
  const ids = data.map((entry: any) => entry.id)
  const plan: [string, string, any][] = []
  for (let step = 0; step < 3; step++) {
    const target = ids[Math.floor(rand() * ids.length)]!
    const op = rand()
    if (op < 0.35) plan.push([target, 'config', { enabled: rand() > 0.5, value: Math.floor(rand() * 3) }])
    else if (op < 0.6) plan.push([target, 'disabled', rand() > 0.5])
    else if (op < 0.8) plan.push([target, 'remove', null])
    else plan.push([target, 'read', null])
  }
  return plan
}

async function runOnce(env: Awaited<ReturnType<typeof setup>>, plan: [string, string, any][], data: any[]) {
  const { loader, applied } = env
  for (const key of Object.keys(applied)) delete applied[key]
  await loader.read(data)
  // the plan is generated from the config, never from the store: the store's
  // key order is not the configuration's order, so a target picked from it
  // would not be reproducible from the seed
  for (const [target, op, value] of plan) {
    // each step is isolated: a tree that throws on one operation must not skip
    // the operations that follow
    try {
      if (op === 'config') await loader.update(target, { config: value })
      else if (op === 'disabled') await loader.update(target, { disabled: value })
      else if (op === 'remove') await loader.remove(target)
      else await loader.read(data)
    } catch {}
    await sleep(5)
  }
  await sleep(10)
}

async function measureInvariants(env: Awaited<ReturnType<typeof setup>>, plan: [string, string, any][], data: any[]) {
  const { loader, applied } = env
  const violations: string[] = []
  const targets = new Set(plan.map(([id]) => id))
  // a step that moves a provider counts as reaching its dependents: the epoch
  // tracks the service binding, not the value inside it, so a provider whose
  // config or verdict the plan changed re-provisions and every dependent
  // reloads
  const movedProviders = new Set(plan
    .filter(([, op]) => op === 'config' || op === 'disabled')
    .map(([id]) => id))

  // an entry nothing reached applies at most once
  for (const entry of data) {
    const id = entry.id
    if (targets.has(id)) continue
    const inject = entry.inject
    const providers = Array.isArray(inject) ? inject : Object.keys(inject ?? {})
    if (providers.some((key) => movedProviders.has(key))) continue
    const count = applied[id] ?? 0
    if (count > 1) violations.push(`unreached ${id} applied ${count} times`)
  }

  // the re-read is the tree's own committed state, so nothing may run again
  const before = { ...applied }
  try {
    await loader.read(loader.data)
  } catch (error: any) {
    violations.push(`re-read threw: ${String(error?.message ?? error)}`)
  }
  await sleep(20)
  for (const id of Object.keys(before)) {
    const after = applied[id] ?? 0
    if (after !== before[id]) violations.push(`re-read moved applied[${id}]: ${before[id]} -> ${after}`)
  }
  return violations
}

describe('Loader: generated configurations', () => {
  it('applies an unreached entry at most once and nothing on a re-read', async () => {
    const violations: string[] = []
    for (let seed = 1; seed <= 200; seed++) {
      const env = await setup()
      const { data } = generate(seed)
      const plan = makePlan(seed, data)
      await runOnce(env, plan, data)
      for (const line of await measureInvariants(env, plan, data)) {
        violations.push(`seed ${seed}: ${line}`)
      }
    }
    expect(violations).to.deep.equal([])
  }, 120000)
})
