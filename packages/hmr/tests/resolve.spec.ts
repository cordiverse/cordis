// Differential probe: `resolveEntry` reimplements the `exports` / `main`
// lookup. Compare it against what Node itself resolves, for a matrix of
// manifests. A mismatch is a real defect in the bypass.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveEntry } from '../src/manifest.ts'

const root = join(tmpdir(), 'cordis-resolve-diff')

interface Case {
  name: string
  manifest: Record<string, unknown>
  subpath: string
  format: 'import' | 'commonjs'
}

const cases: Case[] = [
  { name: 'main-string', manifest: { name: 'p', main: 'index.js' }, subpath: '.', format: 'commonjs' },
  { name: 'main-dot', manifest: { name: 'p', main: './lib/a.js' }, subpath: '.', format: 'commonjs' },
  { name: 'exports-string', manifest: { name: 'p', exports: './a.js' }, subpath: '.', format: 'commonjs' },
  { name: 'exports-conditions', manifest: { name: 'p', exports: { import: './i.mjs', require: './c.cjs' } }, subpath: '.', format: 'commonjs' },
  { name: 'exports-conditions-cjs', manifest: { name: 'p', exports: { import: './i.mjs', require: './c.cjs' } }, subpath: '.', format: 'commonjs' },
  { name: 'exports-subpath', manifest: { name: 'p', exports: { '.': './a.js', './sub': './b.js' } }, subpath: './sub', format: 'commonjs' },
  { name: 'exports-wildcard', manifest: { name: 'p', exports: { './*': './src/*.js' } }, subpath: './x', format: 'commonjs' },
  { name: 'exports-default', manifest: { name: 'p', exports: { default: './d.js' } }, subpath: '.', format: 'commonjs' },
  { name: 'exports-nested', manifest: { name: 'p', exports: { '.': { node: { import: './n.mjs', require: './n.cjs' } } } }, subpath: '.', format: 'commonjs' },
  { name: 'exports-array', manifest: { name: 'p', exports: { '.': ['./x.js', './y.js'] } }, subpath: '.', format: 'commonjs' },
]

describe('manifest resolveEntry', () => {
  it('agrees with the resolver on every case', () => {
    rmSync(root, { recursive: true, force: true })
    const report: string[] = []

    for (const item of cases) {
      const dir = join(root, item.name, 'node_modules', 'p')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(root, item.name, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }))
      writeFileSync(join(dir, 'package.json'), JSON.stringify(item.manifest))
      // every target file the matrix may name
      for (const file of ['index.js', 'lib/a.js', 'a.js', 'i.mjs', 'c.cjs', 'b.js', 'src/x.js', 'd.js', 'n.mjs', 'n.cjs', 'x.js', 'y.js']) {
        mkdirSync(join(dir, file, '..'), { recursive: true })
        writeFileSync(join(dir, file), 'module.exports = 1\n')
      }

      const specifier = item.subpath === '.' ? 'p' : 'p/' + item.subpath.slice(2)
      let nodeAnswer: string | undefined
      try {
        const req = createRequire(join(root, item.name, 'package.json'))
        nodeAnswer = req.resolve(specifier)
      } catch {
        nodeAnswer = undefined
      }
      const ours = resolveEntry(dir, item.subpath, item.format)
      const same = nodeAnswer === undefined
        ? ours === undefined
        : ours !== undefined && nodeAnswer.replace(/\\/g, '/').endsWith(ours.replace(/\\/g, '/'))
      report.push(`${same ? 'OK  ' : 'DIFF'} ${item.name}: node=${nodeAnswer ?? '(none)'} ours=${ours ?? '(none)'}`)
    }

    expect(report.filter(line => line.startsWith('DIFF'))).to.deep.equal([])
  }, 60000)

  it('picks the condition of the side the lookup came from', () => {
    const dir = join(root, 'conditions', 'node_modules', 'p')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'p',
      exports: { '.': { node: { import: './i.mjs', require: './c.cjs' } } },
    }))
    // `require.resolve` can only answer for the CJS side, so the import side
    // is pinned by its expected target
    expect(resolveEntry(dir, '.', 'import')?.replace(/\\/g, '/')).to.match(/i\.mjs$/)
    expect(resolveEntry(dir, '.', 'commonjs')?.replace(/\\/g, '/')).to.match(/c\.cjs$/)
    // a subpath the manifest does not export resolves to nothing, not to `main`
    expect(resolveEntry(dir, './missing', 'import')).to.equal(undefined)
  })
})
