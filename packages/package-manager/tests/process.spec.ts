import { describe, expect, it } from 'vitest'
import { createEnv, run } from '../src/process.ts'

describe.skipIf(process.platform === 'win32')('run', () => {
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
