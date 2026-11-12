import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const pExecFile = promisify(execFile)

function cleanStderr(stderr: string) {
  return stderr.split('\n').filter(line => {
    return !line.includes('DeprecationWarning') && !line.includes('--trace-deprecation')
  }).join('\n').trim()
}

describe('bin.js bootstrap lifecycle', () => {
  it('reports a bootstrap failure and exits non-zero', async () => {
    // inside the package, so `--import tsx` resolves through the repo's node_modules
    const fixtureBase = fileURLToPath(new URL('./', import.meta.url))
    const dir = await fs.mkdtemp(path.join(fixtureBase, '.tmp-bin-test-'))
    const binPath = fileURLToPath(new URL('../bin.js', import.meta.url))
    const execArgs = ['--expose-internals', '--import', 'tsx', '--import', '@cordisjs/unyaml', binPath]
    try {
      // 1. the config file is not there
      const missing = await pExecFile(process.execPath, execArgs, { cwd: dir }).catch(err => err)
      expect(missing.code).toBe(1)
      expect(missing.stderr).toMatch(/config file not found/)

      // 2. the config file does not parse
      await fs.writeFile(path.join(dir, 'cordis.yml'), ': invalid : [')
      const bad = await pExecFile(process.execPath, execArgs, { cwd: dir }).catch(err => err)
      expect(bad.code).toBe(1)
      // include wraps the parser's message in a ConfigFileError
      expect(bad.stderr).toMatch(/failed to parse config file/)

      // 3. the config file names a component that cannot be resolved
      await fs.writeFile(path.join(dir, 'cordis.yml'), '- name: non-existent-component-foo')
      const unknown = await pExecFile(process.execPath, execArgs, { cwd: dir }).catch(err => err)
      expect(unknown.code).toBe(1)
      expect(unknown.stderr).toMatch(/non-existent-component-foo/)

      // 4. a config that loads exits 0 and says nothing
      await fs.writeFile(path.join(dir, 'cordis.yml'), '[]')
      const ok = await pExecFile(process.execPath, execArgs, { cwd: dir })
      expect(ok.stdout).toBe('')
      expect(cleanStderr(ok.stderr)).toBe('')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 120000)
})
