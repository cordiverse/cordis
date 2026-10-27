import { describe, expect, it } from 'vitest'
import { groupUnits, scopesOverlap, type Stale } from '../src/unit.ts'

function stale(url: string, closure: string[], changed: string[], edges: [string, string][] = []): Stale {
  // `edges` names the dependencies inside the closure as `[dependent, dependency]`
  const dependents = new Map<string, Set<string>>()
  for (const [parent, child] of edges) {
    if (!closure.includes(parent) || !closure.includes(child)) continue
    let parents = dependents.get(child)
    if (!parents) dependents.set(child, parents = new Set())
    parents!.add(parent)
  }
  return {
    url,
    urls: [url],
    plugin: undefined as any,
    runtime: undefined as any,
    closure: new Set(closure),
    changed: new Set(changed),
    dependents,
  }
}

describe('unit grouping', () => {
  it('keeps plugins with disjoint changed files apart', () => {
    const units = groupUnits([
      stale('p1', ['p1', 'a-dep'], ['a-dep'], [['p1', 'a-dep']]),
      stale('p2', ['p2', 'b-dep'], ['b-dep'], [['p2', 'b-dep']]),
    ])
    expect(units).to.have.length(2)
    // each unit evicts its own plugin and dependency, nothing else
    expect([...units[0].scope].sort()).to.deep.equal(['a-dep', 'p1'])
    expect([...units[1].scope].sort()).to.deep.equal(['b-dep', 'p2'])
  })

  it('joins plugins that share a changed file', () => {
    const units = groupUnits([
      stale('p1', ['p1', 'shared'], ['shared'], [['p1', 'shared']]),
      stale('p2', ['p2', 'shared'], ['shared'], [['p2', 'shared']]),
    ])
    expect(units).to.have.length(1)
    expect([...units[0].scope].sort()).to.deep.equal(['p1', 'p2', 'shared'])
  })

  it('does not join plugins through an unchanged shared module', () => {
    const units = groupUnits([
      stale('p1', ['p1', 'keep', 'u-dep'], ['u-dep'], [['p1', 'keep'], ['p1', 'u-dep']]),
      stale('p2', ['p2', 'keep', 'v-dep'], ['v-dep'], [['p2', 'keep'], ['p2', 'v-dep']]),
    ])
    expect(units).to.have.length(2)
    // `keep` reaches neither change, so it stays out of both scopes
    expect([...units[0].scope].sort()).to.deep.equal(['p1', 'u-dep'])
    expect([...units[1].scope].sort()).to.deep.equal(['p2', 'v-dep'])
    expect(scopesOverlap(units[0], units[1])).to.equal(false)
  })

  it('evicts a module between the plugin and the changed file', () => {
    const units = groupUnits([
      stale('p1', ['p1', 'mid', 'mid-dep'], ['mid-dep'], [['p1', 'mid'], ['mid', 'mid-dep']]),
    ])
    expect(units).to.have.length(1)
    // `mid` depends on the changed file, so a change reaches it
    expect([...units[0].scope].sort()).to.deep.equal(['mid', 'mid-dep', 'p1'])
  })

  it('leaves a module no change reaches unevicted', () => {
    const units = groupUnits([
      stale('p1', ['p1', 'counter', 'reach'], ['reach'], [['p1', 'counter'], ['p1', 'reach']]),
    ])
    expect([...units[0].scope].sort()).to.deep.equal(['p1', 'reach'])
  })

  it('merges a chain of overlapping changed files into one unit', () => {
    const units = groupUnits([
      stale('p1', ['p1', 'a-dep', 'shared'], ['a-dep', 'shared'], [['p1', 'a-dep'], ['p1', 'shared']]),
      stale('p2', ['p2', 'shared', 'b-dep'], ['shared', 'b-dep'], [['p2', 'shared'], ['p2', 'b-dep']]),
      stale('p3', ['p3', 'keep'], []),
    ])
    // p1 and p2 share `shared`; p3 answers for nothing that overlaps
    expect(units).to.have.length(2)
    const merged = units.find(unit => unit.plugins.length === 2)!
    expect(merged.plugins.map(entry => entry.url).sort()).to.deep.equal(['p1', 'p2'])
    expect([...merged.changed].sort()).to.deep.equal(['a-dep', 'b-dep', 'shared'])
    const alone = units.find(unit => unit.plugins.length === 1)!
    expect(alone.plugins[0].url).to.equal('p3')
    expect(scopesOverlap(merged, alone)).to.equal(false)
  })

  it('never lets two units share an evicted module', () => {
    const units = groupUnits([
      // `shared` is a changed file inside both closures, so it belongs to both
      // changed sets — which is exactly what merges the two into one unit
      stale('p1', ['p1', 'a-dep', 'shared'], ['a-dep', 'shared'], [['p1', 'a-dep'], ['p1', 'shared']]),
      stale('p2', ['p2', 'shared', 'b-dep'], ['shared'], [['p2', 'shared'], ['p2', 'b-dep']]),
      stale('p3', ['p3', 'keep', 'u-dep', 'v-dep'], ['u-dep', 'v-dep'], [['p3', 'keep'], ['p3', 'u-dep'], ['p3', 'v-dep']]),
      stale('p4', ['p4', 'mid', 'mid-dep'], ['mid-dep'], [['p4', 'mid'], ['mid', 'mid-dep']]),
    ])
    expect(units).to.have.length(3)
    for (const [i, a] of units.entries()) {
      for (const b of units.slice(i + 1)) {
        expect(scopesOverlap(a, b), `${a.plugins[0].url} vs ${b.plugins[0].url}`).to.equal(false)
      }
    }
  })
})
