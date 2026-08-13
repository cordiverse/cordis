import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, describe, it } from 'vitest'

const execFileAsync = promisify(execFile)

const packages = [
  ['cordis', 'context.ts'],
  ['@cordisjs/plugin-loader', 'index.ts'],
  ['@cordisjs/plugin-timer', 'index.ts'],
]

describe('Package', () => {
  it.each(packages)('%s includes exported source files', async (name, source) => {
    const { stdout } = await execFileAsync(process.env.npm_execpath!, [
      'workspace',
      name,
      'pack',
      '--dry-run',
      '--json',
    ])
    const files = stdout.trim().split('\n').map(line => JSON.parse(line).location).filter(Boolean)
    expect(files).to.include(`src/${source}`)
  })
})
