import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

const bin = resolve(dirname(fileURLToPath(import.meta.url)), '../src/bin.ts')
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

function run(args: string[], cwd: string) {
  return new Promise<{ code: number, output: string }>((done) => {
    execFile(process.execPath, ['--import', tsx, bin, ...args], { cwd }, (error, stdout, stderr) => {
      const code = (error as any)?.code
      done({ code: typeof code === 'number' ? code : 0, output: `${stdout}${stderr}` })
    })
  })
}

// `--yes` must not turn `.` or `..` into consent to delete the working directory.
// The working directory is nested under a disposable parent, so a regressed
// guard can only remove this test's own sandbox.
it('refuses to remove the working directory or an ancestor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cordis-create-refuse-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  // `.` is only a deletion target when the directory is not empty
  await writeFile(join(cwd, '.npmrc'), 'registry=http://127.0.0.1:9/\n')

  for (const name of ['.', '..']) {
    const { code, output } = await run([name, '--yes'], cwd)
    expect(code).toBe(1)
    expect(output).toContain('refusing to remove')
    expect(output).not.toContain('Done.')
  }
}, 30000)
