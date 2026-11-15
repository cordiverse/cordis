import { Context, Fiber, FiberState } from 'cordis'
import Fs, { FsError } from '@cordisjs/fs'
import { Volume } from '@cordisjs/fs-memory'
import { afterEach, describe, expect, it } from 'vitest'
import * as env from '../src/index.ts'

const mode = process.env.NODE_ENV ?? 'development'

describe('env', () => {
  const fibers: Fiber[] = []
  const keys = new Set<string>()

  afterEach(async () => {
    for (const fiber of fibers.splice(0)) await fiber.dispose()
    for (const key of keys) delete process.env[key]
    keys.clear()
  })

  async function setup(volume: Volume) {
    const root = new Context()
    fibers.push(await root.use(Fs, { baseUrl: 'mem://app/' }))
    root.fs.mount('mem:', volume)
    return root
  }

  // sets a variable of the process environment for the current test
  function stub(key: string, value: string) {
    keys.add(key)
    process.env[key] = value
  }

  it('loads the files in priority order', async () => {
    const ctx = await setup(new Volume({
      'mem://app/.env': 'CORDIS_ENV_A=env\nCORDIS_ENV_B=env\nCORDIS_ENV_C=env\n',
      'mem://app/.env.local': 'CORDIS_ENV_B=local\nCORDIS_ENV_C=local\n',
      [`mem://app/.env.${mode}.local`]: 'CORDIS_ENV_C=mode-local\n',
    }))
    fibers.push(await ctx.plugin(env))
    expect(ctx.get('env')).to.include({
      CORDIS_ENV_A: 'env',
      CORDIS_ENV_B: 'local',
      CORDIS_ENV_C: 'mode-local',
    })
  })

  it('takes a variable of the process environment over the files', async () => {
    const ctx = await setup(new Volume({
      'mem://app/.env': 'CORDIS_ENV_A=env\nCORDIS_ENV_B=env\n',
    }))
    stub('CORDIS_ENV_A', 'process')
    fibers.push(await ctx.plugin(env))
    expect(ctx.get('env')).to.include({ CORDIS_ENV_A: 'process', CORDIS_ENV_B: 'env' })
  })

  it('does not modify the process environment', async () => {
    const ctx = await setup(new Volume({
      'mem://app/.env': 'CORDIS_ENV_A=env\nCORDIS_ENV_B=env\n',
    }))
    stub('CORDIS_ENV_B', 'process')
    const before = { ...process.env }
    fibers.push(await ctx.plugin(env))
    expect(ctx.get('env')?.CORDIS_ENV_A).to.equal('env')
    expect(process.env).to.deep.equal(before)
  })

  it('expands a reference to a variable declared before', async () => {
    const ctx = await setup(new Volume({
      // the referenced variable sorts after the one that references it
      'mem://app/.env': 'CORDIS_ENV_Z_HOST=localhost\nCORDIS_ENV_A_URL=http://${CORDIS_ENV_Z_HOST}/\n',
    }))
    fibers.push(await ctx.plugin(env))
    expect(ctx.get('env')?.CORDIS_ENV_A_URL).to.equal('http://localhost/')
  })

  it('expands a reference to a variable of the process environment', async () => {
    const ctx = await setup(new Volume({
      'mem://app/.env': 'CORDIS_ENV_URL=http://${CORDIS_ENV_HOST}/\n',
    }))
    stub('CORDIS_ENV_HOST', 'localhost')
    fibers.push(await ctx.plugin(env))
    expect(ctx.get('env')?.CORDIS_ENV_URL).to.equal('http://localhost/')
  })

  it('reads the files again on a restart', async () => {
    const ctx = await setup(new Volume({
      'mem://app/.env': 'CORDIS_ENV_A=old\nCORDIS_ENV_B=old\n',
    }))
    const fiber = await ctx.plugin(env)
    fibers.push(fiber)
    await ctx.fs.file('mem://app/.env').write('CORDIS_ENV_A=new\n')
    await fiber.restart()
    expect(ctx.get('env')?.CORDIS_ENV_A).to.equal('new')
    expect(ctx.get('env')).not.to.have.property('CORDIS_ENV_B')
  })

  it('resolves the files against `ctx.fs.baseUrl`', async () => {
    const ctx = await setup(new Volume({
      'mem://other/.env': 'CORDIS_ENV_A=other\n',
    }))
    const scoped = ctx.intercept('fs', { baseUrl: 'mem://other/' })
    fibers.push(await scoped.plugin(env))
    expect(ctx.get('env')?.CORDIS_ENV_A).to.equal('other')
  })

  it('provides `ctx.env` once the files are loaded', async () => {
    const ctx = await setup(new Volume({
      'mem://app/.env': 'CORDIS_ENV_A=env\n',
    }))
    let value: string | undefined
    const consumer = ctx.inject(['env'], (ctx) => {
      value = ctx.env.CORDIS_ENV_A
    })
    fibers.push(consumer)
    fibers.push(await ctx.plugin(env))
    await consumer
    expect(value).to.equal('env')
  })

  it('provides a read-only `ctx.env`', async () => {
    const ctx = await setup(new Volume({
      'mem://app/.env': 'CORDIS_ENV_A=env\n',
    }))
    fibers.push(await ctx.plugin(env))
    expect(Object.isFrozen(ctx.get('env'))).to.equal(true)
  })

  describe('populate', () => {
    it('assigns the variables of the files while the component is active', async () => {
      const ctx = await setup(new Volume({
        'mem://app/.env': 'CORDIS_ENV_A=env\nCORDIS_ENV_B=env\n',
      }))
      keys.add('CORDIS_ENV_A')
      stub('CORDIS_ENV_B', 'process')
      const fiber = await ctx.plugin(env, { populate: true })
      fibers.push(fiber)
      expect(process.env.CORDIS_ENV_A).to.equal('env')
      expect(process.env.CORDIS_ENV_B).to.equal('process')
      await fiber.dispose()
      expect(process.env).not.to.have.property('CORDIS_ENV_A')
      expect(process.env.CORDIS_ENV_B).to.equal('process')
    })

    it('keeps a variable changed by others after the assignment', async () => {
      const ctx = await setup(new Volume({
        'mem://app/.env': 'CORDIS_ENV_A=env\n',
      }))
      keys.add('CORDIS_ENV_A')
      const fiber = await ctx.plugin(env, { populate: true })
      fibers.push(fiber)
      process.env.CORDIS_ENV_A = 'other'
      await fiber.dispose()
      expect(process.env.CORDIS_ENV_A).to.equal('other')
    })
  })

  it('fails on an error other than a missing file', async () => {
    const ctx = await setup(new Volume({}, {
      hook(operation, url) {
        if (url.href !== 'mem://app/.env.local') return
        throw new FsError('PermissionDenied', url, `cannot ${operation} ${url.href}`)
      },
    }))
    const fiber = ctx.plugin(env)
    fibers.push(fiber)
    await fiber.await().catch(() => {})
    expect(fiber.state).to.equal(FiberState.FAILED)
    expect(ctx.get('env')).to.be.undefined
  })
})
