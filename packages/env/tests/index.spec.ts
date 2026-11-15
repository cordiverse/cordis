import { Context, Fiber, FiberState } from 'cordis'
import Fs, { FsError, FsProvider } from '@cordisjs/fs'
import { afterEach, describe, expect, it } from 'vitest'
import * as env from '../src/index.ts'

const mode = process.env.NODE_ENV ?? 'development'

// serves the files of `files` below `mem://`, and fails on the locations of `errors`
function memory(files: Record<string, string>, errors: Record<string, FsError.Code> = {}): FsProvider {
  return {
    read(url) {
      return new ReadableStream({
        start(controller) {
          if (url.href in errors) {
            controller.error(new FsError(errors[url.href], url, `cannot read ${url.href}`))
          } else if (url.href in files) {
            controller.enqueue(new TextEncoder().encode(files[url.href]))
            controller.close()
          } else {
            controller.error(new FsError('NotFound', url, `${url.href} does not exist`))
          }
        },
      })
    },
  }
}

describe('env', () => {
  const fibers: Fiber[] = []
  const keys = new Set<string>()

  afterEach(async () => {
    for (const fiber of fibers.splice(0)) await fiber.dispose()
    for (const key of keys) delete process.env[key]
    keys.clear()
  })

  async function setup(provider: FsProvider, ...names: string[]) {
    for (const name of names) keys.add(name)
    const root = new Context()
    fibers.push(await root.use(Fs, { baseUrl: 'mem://app/' }))
    root.fs.mount('mem:', provider)
    return root
  }

  it('loads the files in priority order, without overriding existing variables', async () => {
    const ctx = await setup(memory({
      'mem://app/.env': 'CORDIS_ENV_A=env\nCORDIS_ENV_B=env\nCORDIS_ENV_C=env\nCORDIS_ENV_D=env\n',
      'mem://app/.env.local': 'CORDIS_ENV_B=local\nCORDIS_ENV_C=local\n',
      [`mem://app/.env.${mode}.local`]: 'CORDIS_ENV_C=mode-local\n',
    }), 'CORDIS_ENV_A', 'CORDIS_ENV_B', 'CORDIS_ENV_C', 'CORDIS_ENV_D')
    process.env.CORDIS_ENV_D = 'process'
    fibers.push(await ctx.plugin(env))
    expect(process.env.CORDIS_ENV_A).to.equal('env')
    expect(process.env.CORDIS_ENV_B).to.equal('local')
    expect(process.env.CORDIS_ENV_C).to.equal('mode-local')
    expect(process.env.CORDIS_ENV_D).to.equal('process')
  })

  it('expands a reference to a variable declared before', async () => {
    const ctx = await setup(memory({
      // the referenced variable sorts after the one that references it
      'mem://app/.env': 'CORDIS_ENV_Z_HOST=localhost\nCORDIS_ENV_A_URL=http://${CORDIS_ENV_Z_HOST}/\n',
    }), 'CORDIS_ENV_Z_HOST', 'CORDIS_ENV_A_URL')
    fibers.push(await ctx.plugin(env))
    expect(process.env.CORDIS_ENV_A_URL).to.equal('http://localhost/')
  })

  it('resolves the files against `ctx.fs.baseUrl`', async () => {
    const ctx = await setup(memory({
      'mem://other/.env': 'CORDIS_ENV_A=other\n',
    }), 'CORDIS_ENV_A')
    fibers.push(await ctx.intercept('fs', { baseUrl: 'mem://other/' }).plugin(env))
    expect(process.env.CORDIS_ENV_A).to.equal('other')
  })

  it('provides `ctx.env` once the files are loaded', async () => {
    const ctx = await setup(memory({
      'mem://app/.env': 'CORDIS_ENV_A=env\n',
    }), 'CORDIS_ENV_A')
    let value: string | undefined
    const consumer = ctx.inject(['env'], (ctx) => {
      value = ctx.env.CORDIS_ENV_A
    })
    fibers.push(consumer)
    fibers.push(await ctx.plugin(env))
    await consumer
    expect(value).to.equal('env')
  })

  it('fails on an error other than a missing file', async () => {
    const ctx = await setup(memory({}, {
      'mem://app/.env.local': 'PermissionDenied',
    }))
    const fiber = ctx.plugin(env)
    fibers.push(fiber)
    await fiber.await().catch(() => {})
    expect(fiber.state).to.equal(FiberState.FAILED)
    expect(ctx.get('env')).to.be.undefined
  })
})
