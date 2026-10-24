// Runs in a plain node process: the test runner's chain never calls load
// hooks (measured), so a flipped `type` is verified where it happens.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { invalidate } from '../../src/manifest.ts'

const dir = join(tmpdir(), `cordis-flip-${process.pid}`)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const manifest = (type: string) => writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', type }))
manifest('commonjs')
writeFileSync(join(dir, 'm.js'), 'module.exports = "CJS"\n')
const url = pathToFileURL(join(dir, 'm.js')).href

const first = (await import(url)).default

// the same file, now ESM, behind a manifest that says so
manifest('module')
writeFileSync(join(dir, 'm.js'), 'export default "ESM"\n')
invalidate(pathToFileURL(dir).href)
const second = (await import(`${url}?flip`)).default

console.log(`FLIP first=${first} second=${second}`)
rmSync(dir, { recursive: true, force: true })
