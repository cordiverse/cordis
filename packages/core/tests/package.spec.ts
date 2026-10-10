import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const yarn = {
  command: process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'corepack',
  prefix: process.platform === 'win32' ? ['/d', '/s', '/c', 'corepack.cmd', 'yarn'] : ['yarn'],
}

const packages = [
  ['cordis', new URL('../package.json', import.meta.url)],
  ['@cordisjs/plugin-loader', new URL('../../loader/package.json', import.meta.url)],
  ['@cordisjs/plugin-timer', new URL('../../timer/package.json', import.meta.url)],
] as const

describe('Package', () => {
  it.each(packages)('%s exposes only archive-backed entry points', async (name, manifestPath) => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const { stdout } = await execFileAsync(yarn.command, [
      ...yarn.prefix,
      'workspace',
      name,
      'pack',
      '--dry-run',
      '--json',
    ])
    const entries = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
    const files = entries.map(entry => entry.location).filter(Boolean)

    expect(manifest.exports).not.toHaveProperty('./src/*')
    expect(manifest.publishConfig?.exports).toBeUndefined()
    expect(files.some(file => file === 'src' || file.startsWith('src/'))).toBe(false)
  })
})
