import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const pExecFile = promisify(execFile)

function cleanStderr(stderr: string) {
  return stderr.split('\n').filter(line => {
    return !line.includes('DeprecationWarning') && !line.includes('--trace-deprecation')
  }).join('\n').trim()
}

describe('bin.js bootstrap lifecycle', () => {
  it('reports errors and exits with code 1 when bootstrap fails', async () => {
    const fixtureBase = fileURLToPath(new URL('./', import.meta.url))
    const dir = await fs.mkdtemp(path.join(fixtureBase, '.tmp-bin-test-'))
    const binPath = fileURLToPath(new URL('../bin.js', import.meta.url))
    const execArgs = ['--expose-internals', '--import', 'tsx', '--import', '@cordisjs/unyaml', binPath]
    try {
      // 1. config file does not exist
      const res1 = await pExecFile(process.execPath, execArgs, { cwd: dir }).catch(err => err)
      expect(res1.code).toBe(1)
      expect(res1.stderr).toMatch(/config file not found/)

      // 2. malformed YAML syntax
      await fs.writeFile(path.join(dir, 'cordis.yml'), ': invalid : [')
      const res2 = await pExecFile(process.execPath, execArgs, { cwd: dir }).catch(err => err)
      expect(res2.code).toBe(1)
      expect(res2.stderr).toMatch(/YAMLException/)

      // 3. unresolvable plugin
      await fs.writeFile(path.join(dir, 'cordis.yml'), '- name: non-existent-plugin-foo')
      const res3 = await pExecFile(process.execPath, execArgs, { cwd: dir }).catch(err => err)
      expect(res3.code).toBe(1)
      expect(res3.stderr).toMatch(/non-existent-plugin-foo/)

      // 4. normal valid config exits 0 cleanly
      await fs.writeFile(path.join(dir, 'cordis.yml'), '[]')
      const res4 = await pExecFile(process.execPath, execArgs, { cwd: dir })
      expect(res4.stdout).toBe('')
      expect(cleanStderr(res4.stderr)).toBe('')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
