/**
 * Same-parent ordering persistence.
 * Run from the repo root:
 *   node --import tsx packages/include/repro/same-parent-ordering.ts
 *
 * Reorders pass the same parent and the new index. A position-only update does not move.
 */
/* eslint-disable no-console */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context, type Message } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import * as yaml from 'js-yaml'
import Include from '../src/index.ts'

const testsUrl = new URL('../tests/', import.meta.url)

const plugin = (id: string, value = 1) => ({
  id,
  name: './config-plugin',
  config: { tag: id, value },
})

const group = (id: string, config: any[]) => ({
  id,
  name: '@cordisjs/plugin-group',
  group: true,
  config,
})

interface CaseResult {
  name: string
  pass: boolean
  detail: string
}

interface StoredEntry {
  id: string
  config?: { value?: number }
}

const results: CaseResult[] = []

function report(name: string, pass: boolean, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`)
}

function idsOf(entries: { id?: string }[]) {
  return entries.map(entry => entry.id)
}

async function readEntries(filename: string) {
  return yaml.load(await readFile(filename, 'utf8')) as StoredEntry[]
}

async function withInclude(name: string, data: any[], run: (app: {
  include: Include
  filename: string
  errors: () => string[]
  flush: () => Promise<void>
}) => Promise<void>) {
  const filename = fileURLToPath(new URL(`fixtures/${name}`, testsUrl))
  const messages: Message[] = []
  let fiber: { dispose: () => Promise<void> } | undefined
  try {
    await writeFile(filename, yaml.dump(data))
    const ctx = new Context()
    ctx.logger.exporter({ export: message => messages.push(message) })
    fiber = await ctx.plugin(Loader, { baseUrl: testsUrl.href })
    const id = await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: { path: `./fixtures/${name}` },
    })
    await ctx.loader.store[id]!.fiber!.await()
    const include = ctx.loader.store[id]!.subtree as Include
    const flush = async () => {
      await include.flush()
      await ctx.loader.await()
    }
    await flush()
    const errors = () => messages
      .filter(message => message.type === 'error')
      .map(message => message.args.join(' '))
    await run({ include, filename, errors, flush })
  } finally {
    await fiber?.dispose().catch((error: unknown) => {
      console.error(error)
    })
    await rm(filename, { force: true })
  }
}

async function scenario1() {
  await withInclude('repro-same-parent-1a.yml', [plugin('a'), plugin('b'), plugin('c')], async ({ include, filename, flush }) => {
    await include.update('a', {}, null, 2)
    await flush()
    const file = idsOf(await readEntries(filename))
    const memory = idsOf(include.root.data)
    const expected = ['b', 'c', 'a']
    report(
      '1 earlier sibling moved later',
      file.join() === expected.join() && memory.join() === expected.join(),
      `file [${file}] memory [${memory}] expected [${expected}]`,
    )
  })

  await withInclude('repro-same-parent-1b.yml', [plugin('a'), plugin('b'), plugin('c')], async ({ include, filename, flush }) => {
    await include.update('c', {}, null, 0)
    await flush()
    const file = idsOf(await readEntries(filename))
    const memory = idsOf(include.root.data)
    const expected = ['c', 'a', 'b']
    report(
      '1 later sibling moved earlier',
      file.join() === expected.join() && memory.join() === expected.join(),
      `file [${file}] memory [${memory}] expected [${expected}]`,
    )
  })
}

async function scenario2() {
  await withInclude('repro-same-parent-2.yml', [plugin('a'), plugin('b'), plugin('c'), plugin('d')], async ({ include, filename, flush }) => {
    // Both commits land before the write snapshots the journal.
    const first = include.update('a', {}, null, 1)
    const second = include.update('a', {}, null, 3)
    await first
    await second
    await flush()
    const file = idsOf(await readEntries(filename))
    const memory = idsOf(include.root.data)
    const expected = ['b', 'c', 'd', 'a']
    report(
      '2 two same-parent reorders before one flush',
      file.join() === expected.join() && memory.join() === expected.join(),
      `file [${file}] memory [${memory}] expected [${expected}]`,
    )
  })
}

async function scenario3() {
  await withInclude('repro-same-parent-3.yml', [plugin('a'), plugin('b'), plugin('c')], async ({ include, filename, errors, flush }) => {
    const fileOrder = [plugin('b'), plugin('a'), plugin('c')]
    await writeFile(filename, yaml.dump(fileOrder))
    await include.update('a', {}, null, 2)
    await flush()
    const file = idsOf(await readEntries(filename))
    const expected = ['b', 'a', 'c']
    const conflict = errors().filter(line => line.includes('conflict') && line.includes('file wins'))
    const pass = file.join() === expected.join() && conflict.length > 0
    report(
      '3 concurrent file order',
      pass,
      `file [${file}] expected [${expected}] conflicts ${conflict.length ? conflict.join(' | ') : '(none)'}`,
    )
  })
}

async function scenario5() {
  await withInclude('repro-same-parent-5.yml', [plugin('a'), plugin('b'), plugin('c'), plugin('d')], async ({ include, filename, flush }) => {
    const first = include.update('a', {}, null, 3)
    const second = include.update('b', {}, null, 2)
    const third = include.update('a', {}, null, 0)
    await first
    await second
    await third
    await flush()
    const file = idsOf(await readEntries(filename))
    const memory = idsOf(include.root.data)
    const expected = ['a', 'c', 'd', 'b']
    report(
      '5 reorder again after a sibling',
      file.join() === expected.join() && memory.join() === expected.join(),
      `file [${file}] memory [${memory}] expected [${expected}]`,
    )
  })
}

function groupIds(entries: { id: string; config?: { id?: string }[] }[]) {
  const found = entries.find(entry => entry.id === 'g')
  return found?.config?.map(child => child.id) ?? []
}

async function scenario6() {
  await withInclude('repro-same-parent-6a.yml', [plugin('a'), group('g', [plugin('x')])], async ({ include, filename, errors, flush }) => {
    await writeFile(filename, yaml.dump([group('g', [plugin('x'), plugin('a')])]))
    await include.update('a', {}, 'g', 0)
    await flush()
    const entries = await readEntries(filename)
    const file = groupIds(entries)
    const memory = groupIds(include.root.data as { id: string; config?: { id?: string }[] }[])
    const expected = ['x', 'a']
    const conflict = errors().filter(line => line.includes('conflict') && line.includes('file wins') && line.includes('moved both'))
    report(
      '6 both sides move into the same group',
      file.join() === expected.join() && memory.join() === expected.join() && conflict.length > 0,
      `file [${file}] memory [${memory}] expected [${expected}] conflicts ${conflict.length ? conflict.join(' | ') : '(none)'}`,
    )
  })

  await withInclude('repro-same-parent-6b.yml', [plugin('a'), group('g', [plugin('x')])], async ({ include, filename, errors, flush }) => {
    await writeFile(filename, yaml.dump([group('g', [plugin('a'), plugin('x')])]))
    await include.update('a', {}, 'g', 0)
    await flush()
    const entries = await readEntries(filename)
    const file = groupIds(entries)
    const expected = ['a', 'x']
    report(
      '6 same index in the new group is not a conflict',
      file.join() === expected.join() && errors().length === 0,
      `file [${file}] expected [${expected}] errors ${errors().length}`,
    )
  })
}

async function scenario4() {
  await withInclude('repro-same-parent-4a.yml', [plugin('a', 1), plugin('b', 1), plugin('c', 1)], async ({ include, filename, errors, flush }) => {
    await include.update('a', { config: { tag: 'a', value: 2 } })
    await flush()
    const entries = await readEntries(filename)
    const file = idsOf(entries)
    const expected = ['a', 'b', 'c']
    const value = entries.find(entry => entry.id === 'a')?.config?.value
    report(
      '4 config-only edit keeps sibling order',
      file.join() === expected.join() && value === 2 && errors().length === 0,
      `file [${file}] value ${value} errors ${errors().length}`,
    )
  })

  await withInclude('repro-same-parent-4b.yml', [plugin('a', 1), plugin('b', 1), plugin('c', 1)], async ({ include, filename, errors, flush }) => {
    await writeFile(filename, yaml.dump([plugin('a', 1), plugin('b', 9), plugin('c', 1)]))
    await include.update('a', {}, null, 2)
    await flush()
    const entries = await readEntries(filename)
    const file = idsOf(entries)
    const expected = ['b', 'c', 'a']
    const value = entries.find(entry => entry.id === 'b')?.config?.value
    const orderConflicts = errors().filter(line => line.includes('moved both'))
    report(
      '4 order survives a non-order file edit',
      file.join() === expected.join() && value === 9 && orderConflicts.length === 0,
      `file [${file}] expected [${expected}] b.value ${value} order-conflicts ${orderConflicts.length}`,
    )
  })
}

async function main() {
  const scenarios = [scenario1, scenario2, scenario3, scenario4, scenario5, scenario6]
  for (const scenario of scenarios) {
    try {
      await scenario()
    } catch (error) {
      report(scenario.name, false, error instanceof Error ? error.stack ?? error.message : String(error))
    }
  }
  const failed = results.some(result => !result.pass)
  console.log(failed ? `FAILED ${results.filter(result => !result.pass).length}/${results.length}` : `OK ${results.length}`)
  process.exit(failed ? 1 : 0)
}

await main()
