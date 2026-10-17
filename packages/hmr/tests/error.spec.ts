import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Logger from '@cordisjs/plugin-logger-console'
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { expect, describe, it, beforeAll, afterAll, afterEach } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { handleError } from '../src/error.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const SETTLE_MS = 500

// Helper: read and backup a file, returning restore function
function backupFile(filename: string) {
  const path = resolve(testDir, filename)
  const original = readFileSync(path, 'utf-8')
  return {
    path,
    original,
    modify(replaceFn: (content: string) => string) {
      writeFileSync(path, replaceFn(original))
    },
    write(content: string) {
      writeFileSync(path, content)
    },
    restore() {
      writeFileSync(path, original)
    },
  }
}

// Helper: wait for a condition
function waitFor(condFn: () => boolean | any, timeout = 8000, interval = 100): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const check = setInterval(() => {
      if (condFn()) {
        clearInterval(check)
        resolve()
      }
    }, interval)
    setTimeout(() => {
      clearInterval(check)
      reject(new Error('waitFor timed out'))
    }, timeout)
  })
}

async function createContext(configFile: string): Promise<{ ctx: Context; fiber: Fiber<Context> }> {
  const ctx = new Context()
  await ctx.plugin(Logger)
  const fiber = await ctx.plugin(Loader)
  await ctx.loader.create({
    name: '@cordisjs/plugin-include',
    config: {
      path: pathToFileURL(resolve(testDir, configFile)).href,
    },
  })
  await waitFor(() => ctx.hmr, 5000)
  await new Promise(r => setTimeout(r, 500))
  return { ctx, fiber }
}

function createFakeContext() {
  const messages: { type: 'warn', args: any[] }[] = []
  const ctx = {
    logger: {
      warn: (...args: any[]) => { messages.push({ type: 'warn', args }) },
    },
  } as any as Context
  return { ctx, messages }
}

describe('handleError', () => {
  // An error without an `errors` array is not a build failure and must be
  // logged as-is.
  it('warns about an ordinary error', () => {
    const { ctx, messages } = createFakeContext()
    handleError(ctx, new Error('ordinary failure'))
    expect(messages).to.have.length(1)
    expect(String(messages[0].args[0])).to.include('ordinary failure')
  })

  // A build failure keeps its dedicated formatting path.
  it('formats a build failure by its errors', () => {
    const { ctx, messages } = createFakeContext()
    handleError(ctx, { errors: [{ text: 'syntax error' }] })
    expect(messages).to.have.length(1)
    expect(String(messages[0].args[0])).to.include('syntax error')
  })

  // The same formatting path applies when the error carries a location.
  it('formats a build failure with a code frame', () => {
    const { ctx, messages } = createFakeContext()
    handleError(ctx, {
      errors: [{
        text: 'boom',
        location: { file: resolve(testDir, 'plugin-throw.ts'), line: 1, column: 1 },
      }],
    })
    expect(messages).to.have.length(1)
    expect(String(messages[0].args[0])).to.include('plugin-throw.ts')
    expect(String(messages[0].args[0])).to.include('boom')
  })

  // An empty `errors` array is not a build failure: `[].every()` is vacuously
  // true, and the build failure branch over it logs nothing.
  it('warns about an error whose errors array is empty', () => {
    const { ctx, messages } = createFakeContext()
    handleError(ctx, Object.assign(new Error('empty errors'), { errors: [] }))
    expect(messages).to.have.length(1)
    expect(String(messages[0].args[0])).to.include('empty errors')
  })

  // A member without `text` is not a build failure either, and reading it would
  // throw out of the handler.
  it('warns about an AggregateError whose member is not an error', () => {
    const { ctx, messages } = createFakeContext()
    handleError(ctx, new AggregateError([undefined], 'All promises were rejected'))
    expect(messages).to.have.length(1)
    expect(String(messages[0].args[0])).to.include('All promises were rejected')
  })
})

describe('hmr: a plugin failing to load during reload', () => {
  let ctx: Context
  let fiber: Fiber<Context>
  // A dedicated fixture: sibling spec files mutate `plugin-error.ts`, and
  // with `pool: forks` they run against this tree concurrently.
  const pluginThrow = backupFile('plugin-throw.ts')
  const messages: { type: 'warn', args: any[] }[] = []

  const ordinaryPlugin = `
import { Context } from 'cordis'

export const name = 'plugin-throw'

throw new Error('ordinary failure during reload')

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-throw', () => 'ok')
}
`

  const emptyErrorsPlugin = `
import { Context } from 'cordis'

export const name = 'plugin-throw'

const error = new Error('empty errors during reload')
;(error as any).errors = []
throw error

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-throw', () => 'ok')
}
`

  // `Promise.any([])` rejects with an `AggregateError` whose `errors` array is
  // empty; this is the shape as a plugin reaches it through a standard API.
  const rejectedAnyPlugin = `
import { Context } from 'cordis'

export const name = 'plugin-throw'

await Promise.any([])

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-throw', () => 'ok')
}
`

  // The same call over a candidate that fails without a reason keeps that
  // reason as the only member of the aggregate.
  const rejectedReasonPlugin = `
import { Context } from 'cordis'

export const name = 'plugin-throw'

await Promise.any([Promise.reject()])

export function apply(ctx: Context) {
  ctx.on('hmr-test/get-throw', () => 'ok')
}
`

  beforeAll(async () => {
    pluginThrow.restore()
    const result = await createContext('cordis-throw.yml')
    ctx = result.ctx
    fiber = result.fiber
    ctx.logger.exporter({ export: message => messages.push(message) })
  }, 10000)

  afterEach(async () => {
    pluginThrow.restore()
    await new Promise(r => setTimeout(r, SETTLE_MS))
  })

  afterAll(async () => {
    await fiber?.dispose()
    await new Promise(r => setTimeout(r, 200))
  })

  // Control: the same reload path with an ordinary error is logged, so the
  // harness below is known to reach handleError.
  it('logs an ordinary module evaluation failure', async () => {
    const before = messages.length
    pluginThrow.write(ordinaryPlugin)
    await waitFor(() => messages.slice(before).some(m => m.type === 'warn' && String(m.args[0]).includes('ordinary failure during reload')))

    // the running plugin is untouched
    expect(ctx.bail('hmr-test/get-throw')).to.equal('ok')
  }, 15000)

  // An empty `errors` array leaves the build failure branch with nothing to
  // log, so the error itself reaches the logger.
  it('logs a module evaluation failure with an empty errors array', async () => {
    const before = messages.length
    pluginThrow.write(emptyErrorsPlugin)
    await waitFor(() => messages.slice(before).some(m => m.type === 'warn' && String(m.args[0]).includes('empty errors during reload')))

    // the running plugin is untouched
    expect(ctx.bail('hmr-test/get-throw')).to.equal('ok')
  }, 15000)

  // The same shape from a standard API, without a hand-built error object.
  it('logs a module evaluation failure whose AggregateError has no members', async () => {
    const before = messages.length
    pluginThrow.write(rejectedAnyPlugin)
    await waitFor(() => messages.slice(before).some(m => m.type === 'warn' && String(m.args[0]).includes('All promises were rejected')))

    expect(ctx.bail('hmr-test/get-throw')).to.equal('ok')
  }, 15000)

  // The member is a rejection reason rather than an error, so it carries no
  // message; the failure still reaches the logger instead of throwing.
  it('logs a module evaluation failure whose AggregateError holds a non-error', async () => {
    const before = messages.length
    pluginThrow.write(rejectedReasonPlugin)
    await waitFor(() => messages.slice(before).some(m => m.type === 'warn'))

    expect(ctx.bail('hmr-test/get-throw')).to.equal('ok')
  }, 15000)

  // `ctx.hmr.watch()` reports a throwing callback through the logger, which is
  // the other caller of the same guard.
  it('logs a watch callback that throws an AggregateError with no members', async () => {
    const target = resolve(testDir, 'watched-throw.txt')
    writeFileSync(target, 'v0')
    await new Promise(r => setTimeout(r, SETTLE_MS))
    try {
      const before = messages.length
      ctx.hmr.watch(target, () => {
        throw new AggregateError([], 'callback failure')
      })
      await new Promise(r => setTimeout(r, SETTLE_MS))
      writeFileSync(target, 'v1')
      await waitFor(() => messages.slice(before).some(m => m.type === 'warn' && String(m.args[0]).includes('callback failure')))
    } finally {
      try { unlinkSync(target) } catch {}
    }
  }, 20000)
})
