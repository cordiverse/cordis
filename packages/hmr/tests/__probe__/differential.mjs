// Differential harness: one scenario, one path. The spec runs this twice —
// once along the HMR path (load, change, reconcile) and once along a cold
// start (change, then load) — and requires the observable states to agree.
//
// The workspace packages are mapped to their sources here: a plain node
// process has no test-runner aliasing, and the built `lib` does not exist in
// the test job.
//
// argv: <scenario> <hmr|cold>
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// argv[4] is a pre-bundled copy of the workspace (see differential.spec.ts).
// Bundling is what keeps the modules inside Node's own `loadCache`: a
// translating loader such as tsx keeps them in its own cache instead, and the
// engine then finds no plugin to reload (measured: every scenario reported
// `replaced: 0`).
const bundle = process.argv[4]
const { Context, Loader, Hmr } = await import(pathToFileURL(bundle).href)

const scenario = process.argv[2]
const mode = process.argv[3]
const dir = join(tmpdir(), `cordis-diff-${scenario}-${mode}-${process.pid}`)

function file(name, content) {
  const path = join(dir, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

const dep = (value) => `export const value = '${value}'\n`

function plugin(name, importFrom) {
  return `
import { value } from '${importFrom}'

export const name = '${name}'

export async function apply(ctx) {
  ctx.on('diff/${name}', () => value)
}
`
}

rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const ctx = new Context()
await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(dir, 'entry.mjs')).href })
await ctx.plugin(Hmr)

async function load(name, content) {
  if (content !== undefined) file(name, content)
  const id = await ctx.loader.create({ name: `./${name}` })
  await ctx.loader.store[id].innerFiber.await().catch(() => {})
}

const observable = {}
const report = {}

if (scenario === 'entry') {
  if (mode === 'hmr') {
    file('dep.ts', dep('a'))
    await load('plugin.ts', plugin('p', './dep.ts'))
    file('dep.ts', dep('b'))
    const result = await ctx.hmr.reconcile({ files: [join(dir, 'dep.ts')] })
    report.replaced = result.replaced.length
    report.pending = result.pending
    report.restart = result.restartReason
    report.aborted = result.aborted ? result.aborted.map(item => item.changed.length) : null
  } else {
    file('dep.ts', dep('b'))
    await load('plugin.ts', plugin('p', './dep.ts'))
  }
  observable.value = ctx.bail('diff/p')
}

if (scenario === 'shared') {
  if (mode === 'hmr') {
    file('shared.ts', dep('s1'))
    await load('a.ts', plugin('a', './shared.ts'))
    await load('b.ts', plugin('b', './shared.ts'))
    file('shared.ts', dep('s2'))
    report.replaced = (await ctx.hmr.reconcile({ files: [join(dir, 'shared.ts')] })).replaced.length
  } else {
    file('shared.ts', dep('s2'))
    await load('a.ts', plugin('a', './shared.ts'))
    await load('b.ts', plugin('b', './shared.ts'))
  }
  observable.a = ctx.bail('diff/a')
  observable.b = ctx.bail('diff/b')
}

if (scenario === 'roots') {
  const pkg = join(dir, 'pkg')
  mkdirSync(pkg, { recursive: true })
  file('pkg/package.json', JSON.stringify({ name: 'p', type: 'module' }))
  const write = (value) => {
    file('pkg/dep.ts', dep(value))
    file('pkg/index.ts', plugin('r', './dep.ts'))
  }
  if (mode === 'hmr') {
    write('d1')
    await load('pkg/index.ts')
    write('d2')
    report.replaced = (await ctx.hmr.reconcile({ roots: [pkg] })).replaced.length
  } else {
    write('d2')
    await load('pkg/index.ts')
  }
  observable.value = ctx.bail('diff/r')
}

if (scenario === 'fix') {
  if (mode === 'hmr') {
    file('dep.ts', dep('f1'))
    await load('plugin.ts', plugin('p', './dep.ts'))
    file('dep.ts', `throw new Error('broken')\n`)
    const broken = await ctx.hmr.reconcile({ files: [join(dir, 'dep.ts')] })
    report.aborted = !!broken.aborted
    report.duringBreak = ctx.bail('diff/p')
    file('dep.ts', dep('f2'))
    report.replacedAfterFix = (await ctx.hmr.reconcile({ files: [join(dir, 'dep.ts')] })).replaced.length
  } else {
    file('dep.ts', dep('f2'))
    await load('plugin.ts', plugin('p', './dep.ts'))
  }
  observable.value = ctx.bail('diff/p')
}

if (scenario === 'type') {
  const write = (type, body) => {
    file('tpkg/package.json', JSON.stringify({ name: 't', type }))
    file('tpkg/m.js', body)
  }
  const entry = `
import value from './tpkg/m.js'

export const name = 'tp'

export async function apply(ctx) {
  ctx.on('diff/tp', () => value)
}
`
  if (mode === 'hmr') {
    write('commonjs', `module.exports = 'CJS'\n`)
    await load('tplugin.ts', entry)
    write('module', `export default 'ESM'\n`)
    const result = await ctx.hmr.reconcile({ files: [join(dir, 'tpkg/m.js')], roots: [join(dir, 'tpkg')] })
    report.replaced = result.replaced.length
    report.aborted = !!result.aborted
  } else {
    write('module', `export default 'ESM'\n`)
    await load('tplugin.ts', entry)
  }
  observable.value = ctx.bail('diff/tp')
}

if (scenario === 'cjs') {
  if (mode === 'hmr') {
    file('dep.cjs', `exports.value = 'c1'\n`)
    await load('plugin.ts', `
import dep from './dep.cjs'

export const name = 'p'

export async function apply(ctx) {
  ctx.on('diff/p', () => dep.value)
}
`)
    file('dep.cjs', `exports.value = 'c2'\n`)
    report.replaced = (await ctx.hmr.reconcile({ files: [join(dir, 'dep.cjs')] })).replaced.length
  } else {
    file('dep.cjs', `exports.value = 'c2'\n`)
    await load('plugin.ts', `
import dep from './dep.cjs'

export const name = 'p'

export async function apply(ctx) {
  ctx.on('diff/p', () => dep.value)
}
`)
  }
  observable.value = ctx.bail('diff/p')
}

if (scenario === 'json') {
  const data = (value) => JSON.stringify({ value })
  if (mode === 'hmr') {
    file('data.json', data('j1'))
    await load('plugin.ts', `
import data from './data.json' with { type: 'json' }

export const name = 'p'

export async function apply(ctx) {
  ctx.on('diff/p', () => data.value)
}
`)
    file('data.json', data('j2'))
    report.replaced = (await ctx.hmr.reconcile({ files: [join(dir, 'data.json')] })).replaced.length
  } else {
    file('data.json', data('j2'))
    await load('plugin.ts', `
import data from './data.json' with { type: 'json' }

export const name = 'p'

export async function apply(ctx) {
  ctx.on('diff/p', () => data.value)
}
`)
  }
  observable.value = ctx.bail('diff/p')
}

if (scenario === 'add') {
  // the plugin switches to a dependency that did not exist before
  const body = (from) => `
import { value } from '${from}'

export const name = 'p'

export async function apply(ctx) {
  ctx.on('diff/p', () => value)
}
`
  if (mode === 'hmr') {
    file('one.ts', dep('o1'))
    await load('plugin.ts', body('./one.ts'))
    file('two.ts', dep('o2'))
    file('plugin.ts', body('./two.ts'))
    report.replaced = (await ctx.hmr.reconcile({ files: [join(dir, 'plugin.ts')] })).replaced.length
  } else {
    file('one.ts', dep('o1'))
    file('two.ts', dep('o2'))
    await load('plugin.ts', body('./two.ts'))
  }
  observable.value = ctx.bail('diff/p')
}

if (scenario === 'main') {
  // a package update moves the entry without touching any loaded file's name
  const pkg = join(dir, 'mpkg')
  mkdirSync(pkg, { recursive: true })
  const manifest = (main) => file('mpkg/package.json', JSON.stringify({ name: 'm', type: 'module', main }))
  const entry = (from) => `
import { value } from '${from}'

export const name = 'm'

export async function apply(ctx) {
  ctx.on('diff/m', () => value)
}
`
  file('mpkg/a.ts', entry('./dep.ts'))
  file('mpkg/b.ts', entry('./dep.ts'))
  file('mpkg/dep.ts', dep('m1'))
  if (mode === 'hmr') {
    manifest('./a.ts')
    await load('mpkg/a.ts')
    manifest('./b.ts')
    file('mpkg/dep.ts', dep('m2'))
    report.replaced = (await ctx.hmr.reconcile({ roots: [pkg] })).replaced.length
  } else {
    manifest('./b.ts')
    file('mpkg/dep.ts', dep('m2'))
    await load('mpkg/b.ts')
  }
  observable.value = ctx.bail('diff/m')
}

if (scenario === 'churn') {
  // reconciling the same roots twice must reload nothing the second time:
  // `files` names what changed and is always applied, `roots` is compared
  // against the identity records
  if (mode === 'hmr') {
    file('dep.ts', dep('n1'))
    await load('plugin.ts', plugin('p', './dep.ts'))
    const first = await ctx.hmr.reconcile({ roots: [dir] })
    const second = await ctx.hmr.reconcile({ roots: [dir] })
    report.warm = first.replaced.length
    report.replaced = second.replaced.length
  } else {
    file('dep.ts', dep('n1'))
    await load('plugin.ts', plugin('p', './dep.ts'))
  }
  observable.value = ctx.bail('diff/p')
}

if (scenario === 'middle') {
  // the changed module sits in the middle of a chain: the plugin imports it
  // through another module, and both have to be re-evaluated
  if (mode === 'hmr') {
    file('leaf.ts', dep('l1'))
    file('mid.ts', `
import { value } from './leaf.ts'
export { value }
`)
    await load('plugin.ts', plugin('p', './mid.ts'))
    file('leaf.ts', dep('l2'))
    report.replaced = (await ctx.hmr.reconcile({ files: [join(dir, 'leaf.ts')] })).replaced.length
  } else {
    file('leaf.ts', dep('l2'))
    file('mid.ts', `
import { value } from './leaf.ts'
export { value }
`)
    await load('plugin.ts', plugin('p', './mid.ts'))
  }
  observable.value = ctx.bail('diff/p')
}

if (scenario === 'delete') {
  // the plugin stops importing a file, and the file is removed in the same batch
  const body = (from) => from
    ? `
import { value } from '${from}'

export const name = 'p'

export async function apply(ctx) {
  ctx.on('diff/p', () => value)
}
`
    : `
export const name = 'p'

export async function apply(ctx) {
  ctx.on('diff/p', () => 'gone')
}
`
  if (mode === 'hmr') {
    file('dep.ts', dep('x1'))
    await load('plugin.ts', body('./dep.ts'))
    rmSync(join(dir, 'dep.ts'), { force: true })
    file('plugin.ts', body(null))
    report.replaced = (await ctx.hmr.reconcile({ files: [join(dir, 'dep.ts'), join(dir, 'plugin.ts')] })).replaced.length
  } else {
    rmSync(join(dir, 'dep.ts'), { force: true })
    await load('plugin.ts', body(null))
  }
  observable.value = ctx.bail('diff/p')
}

if (scenario === 'multi') {
  // two independent units: one breaks, the other commits; then the broken one is fixed
  if (mode === 'hmr') {
    file('bad.ts', dep('b1'))
    file('good.ts', dep('g1'))
    await load('a.ts', plugin('a', './bad.ts'))
    await load('b.ts', plugin('b', './good.ts'))
    file('bad.ts', `throw new Error('broken')\n`)
    file('good.ts', dep('g2'))
    const first = await ctx.hmr.reconcile({ files: [join(dir, 'bad.ts'), join(dir, 'good.ts')] })
    report.aborted = first.aborted ? first.aborted.length : 0
    report.replacedFirst = first.replaced.length
    file('bad.ts', dep('b2'))
    report.replacedAfterFix = (await ctx.hmr.reconcile({ files: [join(dir, 'bad.ts')] })).replaced.length
  } else {
    file('bad.ts', dep('b2'))
    file('good.ts', dep('g2'))
    await load('a.ts', plugin('a', './bad.ts'))
    await load('b.ts', plugin('b', './good.ts'))
  }
  observable.a = ctx.bail('diff/a')
  observable.b = ctx.bail('diff/b')
}

if (scenario === 'host') {
  // The host is whatever the process entry's closure holds, so to make a
  // fixture a host it has to be reachable from the entry: this scenario
  // generates an entry that imports it, runs that entry as its own process,
  // and compares "a restart is required" against "a restart gives the right
  // state" — the comparable form for a host change.
  // the entry is named by its real path: relative imports inherit the entry's
  // path, and the engine compares the changed file against the host closure,
  // which is why a logical path would not match on macOS
  const app = join(realpathSync(dir), 'app.mjs')
  writeFileSync(app, `
import { Context, Loader, Hmr } from ${JSON.stringify(pathToFileURL(bundle).href)}
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// a static import puts the fixture inside the entry's closure, which is what
// makes it a host
import './host.ts'

const mode = process.argv[2]
const dir = process.argv[3]
const dep = (value) => \`export const value = '\${value}'\\n\`

const ctx = new Context()
await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(dir, 'host.ts')).href })
await ctx.plugin(Hmr)
const id = await ctx.loader.create({ name: './host.ts' })
await ctx.loader.store[id].innerFiber.await()

if (mode === 'hmr') {
  writeFileSync(join(dir, 'hostdep.ts'), dep('h2'))
  const result = await ctx.hmr.reconcile({ files: [join(dir, 'hostdep.ts')] })
  console.log('HOST ' + JSON.stringify({ restart: result.restartReason ?? null, value: ctx.bail('diff/h') }))
} else {
  console.log('HOST ' + JSON.stringify({ restart: null, value: ctx.bail('diff/h') }))
}
process.exit(0)
`)
  file('hostdep.ts', dep(mode === 'hmr' ? 'h1' : 'h2'))
  file('host.ts', `
import { value } from './hostdep.ts'

export const name = 'h'

export async function apply(ctx) {
  ctx.on('diff/h', () => value)
}
`)
  const { execFileSync } = await import('node:child_process')
  const output = execFileSync(process.execPath, ['--expose-internals', app, mode, dir], { encoding: 'utf8' })
  const line = output.split('\n').find((item) => item.startsWith('HOST '))
  const hostState = JSON.parse(line.slice(5))
  report.restart = hostState.restart
  observable.value = hostState.value
}

console.log(`DIFF ${JSON.stringify({ observable, report })}`)
process.exit(0)
