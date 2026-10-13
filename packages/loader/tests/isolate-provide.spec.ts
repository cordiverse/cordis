import { expect, describe, it } from 'vitest'
import { Context, FiberState } from 'cordis'
import { setImmediate } from 'node:timers/promises'
import MockLoader from './utils'

declare module 'cordis' {
  interface Context {
    svc: { tag: string }
  }
}

interface Slot {
  key: symbol
  description: string
  impl: Context['reflect']['store'][symbol]
  tag?: string
}

function slots(ctx: Context, name: string): Slot[] {
  const found: Slot[] = []
  for (const key of Reflect.ownKeys(ctx.reflect.store)) {
    if (typeof key !== 'symbol') continue
    const impl = ctx.reflect.store[key]
    if (impl?.name !== name) continue
    found.push({
      key,
      description: key.description ?? '',
      impl,
      tag: impl.value?.tag,
    })
  }
  return found
}

async function boot(plugins: Record<string, (ctx: Context, config?: any) => void>) {
  const root = new Context()
  await root.plugin(MockLoader)
  const loader = root.loader as MockLoader
  for (const [name, plugin] of Object.entries(plugins)) loader.mock(name, plugin)
  return { root, loader }
}

async function started(loader: MockLoader, id: string) {
  const fiber = loader.store[id]?.fiber
  expect(fiber).to.be.ok
  await fiber!.await()
  return fiber!
}

describe('Service Isolation: provide migration', () => {
  it('reloads a self-provider after an isolate-only move', async () => {
    let calls = 0
    let duringReload: Slot[] | undefined
    const { root, loader } = await boot({
      prov: (ctx, config) => {
        calls++
        if (calls > 1) duringReload = slots(ctx, 'svc')
        ctx.provide('svc', { tag: config?.tag ?? 'init' })
      },
    })

    const id = await loader.create({ name: 'prov', config: { tag: 'init' } })
    await started(loader, id)
    expect(calls).to.equal(1)
    const before = slots(root, 'svc')
    expect(before).to.have.length(1)

    await loader.update(id, { isolate: { svc: true } })
    expect(calls).to.equal(1)
    const after = slots(root, 'svc')
    expect(after).to.have.length(1)
    expect(after[0]!.impl).to.equal(before[0]!.impl)
    expect(after[0]!.key).to.not.equal(before[0]!.key)
    expect(root.reflect.store[before[0]!.key]).to.be.undefined
    expect(after[0]!.description).to.equal(`svc#${loader.store[id]!.options.id}`)

    await loader.update(id, { config: { tag: 'reloaded' } })
    await started(loader, id)
    expect(calls).to.equal(2)
    expect(duringReload).to.have.length(0)
    const reloaded = slots(root, 'svc')
    expect(reloaded).to.have.length(1)
    expect(reloaded[0]!.impl).to.not.equal(before[0]!.impl)
    expect(reloaded[0]!.tag).to.equal('reloaded')
    expect(reloaded[0]!.description).to.equal(after[0]!.description)
  })

  it('keeps an impl that reused the abandoned symbol', async () => {
    let calls = 0
    const { root, loader } = await boot({
      prov: (ctx) => {
        calls++
        ctx.provide('svc', { tag: 'prov' })
      },
      other: (ctx) => {
        ctx.provide('svc', { tag: 'other' })
      },
    })

    const id = await loader.create({ name: 'prov' })
    await started(loader, id)
    const before = slots(root, 'svc')
    expect(before).to.have.length(1)

    await loader.update(id, { isolate: { svc: true } })
    expect(calls).to.equal(1)
    const moved = slots(root, 'svc')
    expect(moved).to.have.length(1)
    expect(moved[0]!.impl).to.equal(before[0]!.impl)
    expect(moved[0]!.key).to.not.equal(before[0]!.key)
    expect(moved[0]!.description).to.equal(`svc#${loader.store[id]!.options.id}`)
    expect(root.reflect.store[before[0]!.key]).to.be.undefined

    const otherId = await loader.create({ name: 'other' })
    await started(loader, otherId)
    const other = slots(root, 'svc').find(slot => slot.tag === 'other')
    expect(other?.key).to.equal(before[0]!.key)

    await loader.store[id]!.fiber!.dispose()
    const left = slots(root, 'svc')
    expect(left.some(slot => slot.impl === before[0]!.impl)).to.equal(false)
    expect(left.some(slot => slot.impl === other!.impl)).to.equal(true)
  })

  it('retains a moved provider until its consumers finish cleanup', async () => {
    const gate = Promise.withResolvers<void>()
    const timeline: string[] = []
    const { root, loader } = await boot({
      provider: (ctx, config) => {
        ctx.provide('svc', { tag: config.tag })
        return () => { timeline.push(`closed: ${config.tag}`) }
      },
      consumer: Object.assign((ctx: Context) => async () => {
        await gate.promise
        timeline.push(`read: ${ctx.svc.tag}`)
      }, { inject: ['svc'] }),
    })
    const id = await loader.create({ name: 'provider', config: { tag: 'moved' } })
    const provider = await started(loader, id)
    const original = slots(root, 'svc')[0]!
    const uid = original.impl.uid
    await loader.update(id, { isolate: { svc: 'B' } })
    const moved = slots(root, 'svc')[0]!
    expect(moved.impl).to.equal(original.impl)
    expect(moved.impl.uid).to.equal(uid)

    const otherId = await loader.create({ name: 'provider', config: { tag: 'other' } })
    await started(loader, otherId)
    const other = slots(root, 'svc').find(slot => slot.tag === 'other')!
    expect(other.key).to.equal(original.key)
    const consumerId = await loader.create({ name: 'consumer', isolate: { svc: 'B' } })
    await started(loader, consumerId)

    const task = provider.dispose()
    await setImmediate()
    const duringCleanup = [...timeline]
    gate.resolve()
    await task
    await loader.await()
    expect(duringCleanup).to.deep.equal([])
    expect(timeline).to.deep.equal(['read: moved', 'closed: moved'])
    expect(root.reflect.store[moved.key]).to.be.undefined
    expect(root.reflect.store[other.key]).to.equal(other.impl)
    expect(loader.expectFiber(consumerId).state).to.equal(FiberState.PENDING)
    await root.fiber.dispose()
  })

  it('keeps impls on intermediate symbols across repeated moves', async () => {
    let calls = 0
    const { root, loader } = await boot({
      prov: (ctx) => {
        calls++
        ctx.provide('svc', { tag: 'prov' })
      },
      rootUser: (ctx) => {
        ctx.provide('svc', { tag: 'rootUser' })
      },
      keep: () => {},
      onA: (ctx) => {
        ctx.provide('svc', { tag: 'onA' })
      },
    })

    const id = await loader.create({ name: 'prov' })
    await started(loader, id)
    const rootSlot = slots(root, 'svc')[0]!
    const original = rootSlot.impl

    await loader.update(id, { isolate: { svc: 'A' } })
    expect(calls).to.equal(1)
    const atA = slots(root, 'svc')
    expect(atA).to.have.length(1)
    expect(atA[0]!.impl).to.equal(original)
    expect(atA[0]!.description).to.equal('svc@A')
    expect(root.reflect.store[rootSlot.key]).to.be.undefined

    const rootUserId = await loader.create({ name: 'rootUser' })
    await started(loader, rootUserId)
    const rootUser = slots(root, 'svc').find(slot => slot.tag === 'rootUser')
    expect(rootUser?.key).to.equal(rootSlot.key)

    const keepId = await loader.create({ name: 'keep', isolate: { svc: 'A' } })
    await started(loader, keepId)
    await loader.update(id, { isolate: { svc: 'B' } })
    expect(calls).to.equal(1)
    const atB = slots(root, 'svc').find(slot => slot.impl === original)
    expect(atB?.description).to.equal('svc@B')
    expect(root.reflect.store[atA[0]!.key]).to.be.undefined

    const onAId = await loader.create({ name: 'onA', isolate: { svc: 'A' } })
    await started(loader, onAId)
    const onA = slots(root, 'svc').find(slot => slot.tag === 'onA')
    expect(onA?.key).to.equal(atA[0]!.key)

    await loader.update(id, { isolate: { svc: 'C' } })
    expect(calls).to.equal(1)
    const atC = slots(root, 'svc').find(slot => slot.impl === original)
    expect(atC?.description).to.equal('svc@C')

    await loader.store[id]!.fiber!.dispose()
    const left = slots(root, 'svc')
    expect(left.some(slot => slot.impl === original)).to.equal(false)
    expect(left.some(slot => slot.impl === rootUser!.impl)).to.equal(true)
    expect(left.some(slot => slot.impl === onA!.impl)).to.equal(true)
  })

  it('does not delete another realm when one impl moves', async () => {
    let calls = 0
    const { root, loader } = await boot({
      stay: (ctx) => {
        ctx.provide('svc', { tag: 'stay' })
      },
      move: (ctx) => {
        calls++
        ctx.provide('svc', { tag: 'move' })
      },
    })

    const stayId = await loader.create({ name: 'stay', isolate: { svc: 'stay' } })
    const moveId = await loader.create({ name: 'move', isolate: { svc: 'from' } })
    await started(loader, stayId)
    await started(loader, moveId)
    const stay = slots(root, 'svc').find(slot => slot.tag === 'stay')!
    const move = slots(root, 'svc').find(slot => slot.tag === 'move')!
    expect(stay.description).to.equal('svc@stay')
    expect(move.description).to.equal('svc@from')

    await loader.update(moveId, { isolate: { svc: 'to' } })
    expect(calls).to.equal(1)
    const moved = slots(root, 'svc').find(slot => slot.impl === move.impl)
    const stayAfter = slots(root, 'svc').find(slot => slot.impl === stay.impl)
    expect(moved?.description).to.equal('svc@to')
    expect(moved?.key).to.not.equal(move.key)
    expect(stayAfter?.key).to.equal(stay.key)

    await loader.store[moveId]!.fiber!.dispose()
    const left = slots(root, 'svc')
    expect(left.some(slot => slot.impl === stay.impl)).to.equal(true)
    expect(left.some(slot => slot.impl === move.impl)).to.equal(false)
  })

  it.each(['fiber', 'provide'])('notifies the retained realm on %s disposal after a blocked move', async (mode) => {
    const gate = Promise.withResolvers<void>()
    const disposers: Record<string, () => void> = {}
    const consumers: Record<string, Context> = {}
    const starts: string[] = []
    const stops: string[] = []
    const { root, loader } = await boot({
      provider: (ctx, config) => {
        disposers[config.tag] = ctx.provide('svc', { tag: config.tag })
      },
      consumer: Object.assign((ctx: Context, config: { tag: string }) => {
        consumers[config.tag] = ctx
        starts.push(ctx.svc.tag)
        return async () => {
          await gate.promise
          stops.push(ctx.svc.tag)
        }
      }, { inject: ['svc'] }),
    })
    const first = await loader.create({ name: 'provider', config: { tag: 'first' }, isolate: { svc: 'A' } })
    const second = await loader.create({ name: 'provider', config: { tag: 'second' }, isolate: { svc: 'B' } })
    const ca = await loader.create({ name: 'consumer', config: { tag: 'A' }, isolate: { svc: 'A' } })
    const cb = await loader.create({ name: 'consumer', config: { tag: 'B' }, isolate: { svc: 'B' } })
    for (const id of [first, second, ca, cb]) await started(loader, id)
    const a = slots(root, 'svc').find(slot => slot.tag === 'first')!
    const b = slots(root, 'svc').find(slot => slot.tag === 'second')!

    await loader.update(first, { isolate: { svc: 'B' } })
    expect(root.reflect.store[a.key]).to.equal(a.impl)
    expect(root.reflect.store[b.key]).to.equal(b.impl)
    expect(starts).to.deep.equal(['first', 'second'])
    expect(stops).to.deep.equal([])

    const eventsA: unknown[] = []
    const eventsB: unknown[] = []
    root.isolate('svc', a.key).on('internal/service', (name, value) => {
      if (name === 'svc') eventsA.push(value?.tag)
    })
    root.isolate('svc', b.key).on('internal/service', (name, value) => {
      if (name === 'svc') eventsB.push(value?.tag)
    })
    let completed = false
    const task = Promise.resolve(mode === 'fiber'
      ? loader.expectFiber(first).dispose()
      : disposers.first()).then(() => completed = true)
    await setImmediate()
    const completedDuringCleanup = completed
    gate.resolve()
    await task
    await loader.await()
    expect(completedDuringCleanup).to.equal(false)
    expect(stops).to.deep.equal(['first'])
    expect(loader.expectFiber(ca).state).to.equal(FiberState.PENDING)
    expect(() => consumers.A.svc).to.throw('inactive context')
    expect(loader.expectFiber(cb).state).to.equal(FiberState.ACTIVE)
    expect(consumers.B.svc.tag).to.equal('second')
    expect(root.reflect.store[a.key]).to.be.undefined
    expect(root.reflect.store[b.key]).to.equal(b.impl)
    expect(eventsA).to.deep.equal(mode === 'fiber' ? ['first', undefined] : [undefined])
    expect(eventsB).to.deep.equal([])

    const replacement = await loader.create({ name: 'provider', config: { tag: 'replacement' }, isolate: { svc: 'A' } })
    await started(loader, replacement)
    await loader.await()
    expect(loader.expectFiber(ca).state).to.equal(FiberState.ACTIVE)
    expect(consumers.A.svc.tag).to.equal('replacement')
    expect(starts).to.deep.equal(['first', 'second', 'replacement'])
    expect(stops).to.deep.equal(['first'])
    expect(loader.expectFiber(cb).state).to.equal(FiberState.ACTIVE)
    expect(consumers.B.svc.tag).to.equal('second')
    expect(eventsB).to.deep.equal([])
  })
})
