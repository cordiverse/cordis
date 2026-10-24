import { expect, describe, it } from 'vitest'
import { collectDependencies, isBuiltin } from '../src/graph.ts'

// `ModuleJob.linked` is a promise on 22 and an array on 24; the walk only ever
// awaits it, so a promise is enough here.
function graph(edges: Record<string, string[]>) {
  const jobs = new Map<string, any>()
  const make = (url: string): any => {
    let job = jobs.get(url)
    if (job) return job
    job = { url }
    jobs.set(url, job)
    job.linked = Promise.resolve((edges[url] ?? []).map(make))
    return job
  }
  return make
}

describe('collectDependencies', () => {
  it('walks through node_modules', async () => {
    const make = graph({
      'file:///app/plugin.ts': ['file:///app/node_modules/lib/index.js'],
      'file:///app/node_modules/lib/index.js': ['file:///app/node_modules/shared/index.js'],
      'file:///app/node_modules/shared/index.js': [],
    })
    const urls = await collectDependencies(make('file:///app/plugin.ts'))
    // the shared dependency lives in node_modules; leaving it out is what kept
    // a change to it from reaching the plugin that imports it
    expect([...urls]).to.deep.equal([
      'file:///app/plugin.ts',
      'file:///app/node_modules/lib/index.js',
      'file:///app/node_modules/shared/index.js',
    ])
  })

  it('skips node: builtins', async () => {
    const make = graph({
      'file:///app/plugin.ts': ['node:path', 'file:///app/dep.ts'],
      'file:///app/dep.ts': [],
    })
    expect([...await collectDependencies(make('file:///app/plugin.ts'))])
      .to.deep.equal(['file:///app/plugin.ts', 'file:///app/dep.ts'])
    expect(isBuiltin('node:path')).to.equal(true)
    expect(isBuiltin('file:///app/node_modules/lib/index.js')).to.equal(false)
  })

  it('stops at the boundary without including it', async () => {
    const make = graph({
      'file:///app/plugin.ts': ['file:///app/node_modules/cordis/index.js', 'file:///app/dep.ts'],
      'file:///app/node_modules/cordis/index.js': ['file:///app/node_modules/cordis/deep.js'],
      'file:///app/node_modules/cordis/deep.js': [],
      'file:///app/dep.ts': [],
    })
    const urls = await collectDependencies(make('file:///app/plugin.ts'), new Set([
      'file:///app/node_modules/cordis/index.js',
    ]))
    // a host module bounds the walk: neither it nor what it imports is part of
    // the unit that can be reloaded in place
    expect([...urls]).to.deep.equal(['file:///app/plugin.ts', 'file:///app/dep.ts'])
  })

  it('leaves package modules out while the host graph is unknown', async () => {
    const make = graph({
      'file:///app/plugin.ts': ['file:///app/node_modules/lib/index.js', 'file:///app/dep.ts'],
      'file:///app/node_modules/lib/index.js': [],
      'file:///app/dep.ts': [],
    })
    const urls = await collectDependencies(make('file:///app/plugin.ts'), undefined, true)
    // without the host graph there is no boundary between a plugin's own
    // dependencies and the framework, so neither is safe to reload
    expect([...urls]).to.deep.equal(['file:///app/plugin.ts', 'file:///app/dep.ts'])
  })

  it('visits a module once when the graph has a cycle', async () => {
    const make = graph({
      'file:///app/a.ts': ['file:///app/b.ts'],
      'file:///app/b.ts': ['file:///app/a.ts'],
    })
    expect([...await collectDependencies(make('file:///app/a.ts'))])
      .to.deep.equal(['file:///app/a.ts', 'file:///app/b.ts'])
  })
})
