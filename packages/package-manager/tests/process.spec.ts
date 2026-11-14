import { describe, expect, it } from 'vitest'
import { createEnv, run } from '../src/process.ts'

describe('run abort reasons', () => {
  it('returns output from a process that completes normally', async () => {
    await expect(run(process.execPath, ['-e', `process.stdout.write('ok')`], {
      cwd: process.cwd(),
      env: createEnv(),
      timeout: 2000,
    })).resolves.toMatchObject({ stdout: 'ok' })
  })

  it('preserves a falsy reason when aborted before spawning', async () => {
    const controller = new AbortController()
    controller.abort(false)
    await expect(run(process.execPath, ['-e', `process.exit(0)`], {
      cwd: process.cwd(),
      env: createEnv(),
      signal: controller.signal,
    })).rejects.toBe(false)
  })

  it.each([false, null, 0, ''])('preserves falsy abort reason %s after the process starts', async (reason) => {
    const controller = new AbortController()
    const script = [
      `process.on('SIGTERM', () => process.exit(0))`,
      `process.stdout.write('ready\\n')`,
      `setInterval(() => {}, 1000)`,
    ].join('\n')
    const result = run(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: createEnv(),
      signal: controller.signal,
      timeout: 10000,
      onOutput: (chunk) => { if (chunk.includes('ready')) controller.abort(reason) },
    })
    await expect(result).rejects.toBe(reason)
  }, 30000)
})

describe.skipIf(process.platform === 'win32')('run', () => {
  it('keeps the first falsy abort reason if a later timeout occurs during cleanup', async () => {
    const controller = new AbortController()
    const script = [
      `process.on('SIGTERM', () => {})`,
      `process.stdout.write('ready\\n')`,
      `setInterval(() => {}, 1000)`,
    ].join('\n')
    await expect(run(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: createEnv(),
      signal: controller.signal,
      timeout: 2000,
      onOutput: (chunk) => { if (chunk.includes('ready')) controller.abort(false) },
    })).rejects.toBe(false)
  }, 30000)

  it('terminates a descendant that ignores SIGTERM after the agent exits', async () => {
    // the agent prints the pid of a descendant that ignores SIGTERM and keeps stdout open
    const script = [
      `const { spawn } = require('node:child_process')`,
      `const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'inherit' })`,
      `process.stdout.write(child.pid + '\\n')`,
      `setInterval(() => {}, 1000)`,
    ].join('\n')
    let pid: number | undefined
    await expect(run(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: createEnv(),
      timeout: 500,
      onOutput: (chunk) => { pid ??= +chunk.trim() },
    })).rejects.toThrow('no output')
    expect(pid).to.be.a('number')
    expect(() => process.kill(pid!, 0)).to.throw()
  }, 30000)
})
