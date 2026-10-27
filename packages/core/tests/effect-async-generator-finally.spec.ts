import { expect, it } from 'vitest'
import { setImmediate as tick } from 'node:timers/promises'
import { Context } from '../src/index.ts'

it('runs the finally block of an async generator effect when the fiber is disposed', async () => {
  const root = new Context()
  const seq: string[] = []
  const gate = Promise.withResolvers<void>()
  const fiber = await root.plugin((ctx) => {
    ctx.effect(async function* () {
      try {
        yield () => seq.push('cleanup-1')
        await gate.promise
        yield () => seq.push('cleanup-2')
      } finally {
        seq.push('finally')
      }
    })
  })

  await tick()
  const disposing = fiber.dispose()
  gate.resolve()
  await disposing
  expect(seq).to.deep.equal(['finally', 'cleanup-2', 'cleanup-1'])
})
