import { writeFileSync, mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { collectDependencies } from '../src/graph.ts'
import { groupUnits, type Stale } from '../src/unit.ts'

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** Deterministic PRNG, so a rerun on the same machine compares like for like. */
function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Stats {
  min: number
  p50: number
  p95: number
}

const round2 = (value: number) => Math.round(value * 100) / 100

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return { min: round2(sorted[0]!), p50: round2(at(0.5)), p95: round2(at(0.95)) }
}

const ROUNDS = 20
const WARMUP = 3

/** Run `fn` `ROUNDS` times and report min / p50 / p95 in milliseconds. */
async function measure(fn: () => unknown): Promise<Stats> {
  for (let i = 0; i < WARMUP; i++) await fn()
  const samples: number[] = []
  for (let i = 0; i < ROUNDS; i++) {
    const start = performance.now()
    await fn()
    samples.push(performance.now() - start)
  }
  return stats(samples)
}

interface Row {
  scenario: string
  scale: string
  stats?: Stats
  note: string
}

const rows: Row[] = []

function record(row: Row) {
  rows.push(row)
  const timing = row.stats
    ? `min ${row.stats.min.toFixed(2)}ms  p50 ${row.stats.p50.toFixed(2)}ms  p95 ${row.stats.p95.toFixed(2)}ms`
    : 'operation count only'
  console.log(`[bench] ${row.scenario} (${row.scale}): ${timing} — ${row.note}`)
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * A `ModuleJob` stand-in. Real Node hands `linked` as a promise on 22 and an
 * array on 24, and its entries are module jobs with the full loader surface;
 * here it is a plain array of `{ url, linked }` objects. `collectDependencies`
 * only ever awaits `linked` and reads `.url`, so the walk it measures is the
 * real one — what this does not exercise is the promise resolution Node does
 * per module, so treat these numbers as a floor on the traversal cost.
 */
function job(url: string, linked: any[] = []): any {
  return { url, linked }
}

/** A root with `width` direct children, each child a leaf. */
function wideTree(width: number) {
  const children = Array.from({ length: width }, (_, index) => job(`file:///bench/dep-${index}.ts`))
  return { root: job('file:///bench/root.ts', children), width }
}

const MODULE_POOL = 5000
const CLOSURE_SIZE = 100

/**
 * `count` stales, each with a 100-module closure drawn from a shared pool of
 * 5000 so closures overlap the way real ones do, 1..5 changed files inside the
 * closure, and random dependency edges inside the closure.
 */
function staleSet(count: number, seed: number): Stale[] {
  const random = mulberry32(seed)
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!
  const stales: Stale[] = []
  for (let index = 0; index < count; index++) {
    const url = `file:///bench/plugin-${index}.ts`
    const closure = new Set<string>([url])
    while (closure.size < CLOSURE_SIZE) {
      closure.add(`file:///bench/mod-${Math.floor(random() * MODULE_POOL)}.ts`)
    }
    const members = [...closure]
    const changed = new Set<string>()
    const changedCount = 1 + Math.floor(random() * 5)
    while (changed.size < changedCount) changed.add(pick(members))
    const dependents = new Map<string, Set<string>>()
    for (const member of members) {
      const parents = 1 + Math.floor(random() * 2)
      for (let i = 0; i < parents; i++) {
        const parent = pick(members)
        if (parent === member) continue
        let set = dependents.get(member)
        if (!set) dependents.set(member, set = new Set())
        set.add(parent)
      }
    }
    stales.push({
      url,
      urls: [url],
      plugin: undefined as any,
      runtime: undefined as any,
      closure,
      changed,
      dependents,
    })
  }
  return stales
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

const OUTPUT = 'D:/Work/编程软件/cordis/.research/bench-results.md'

describe('hmr cost benchmark', () => {
  it('collectDependencies: wide tree', async () => {
    const small = wideTree(1000)
    const large = wideTree(10000)

    // structural sanity first: the walk really visits every node
    expect((await collectDependencies(small.root)).size).to.equal(1001)
    expect((await collectDependencies(large.root)).size).to.equal(10001)

    const smallStats = await measure(() => collectDependencies(small.root))
    record({
      scenario: 'collectDependencies 宽图',
      scale: '1000 子节点',
      stats: smallStats,
      note: '单层宽图，`linked` 为普通数组；真实 Node 的 `linked` 是 promise，故此处为下界',
    })

    const largeStats = await measure(() => collectDependencies(large.root))
    record({
      scenario: 'collectDependencies 宽图',
      scale: '10000 子节点',
      stats: largeStats,
      note: '同上；线性放大验证无超线性退化',
    })

    // loose ceilings only — CI machines vary wildly, this catches hangs not micro-regressions
    expect(smallStats.p50).to.be.below(100)
    expect(largeStats.p50).to.be.below(500)
  })

  it('groupUnits: 1000 stales', async () => {
    const stales = staleSet(1000, 0xc0ffee)

    const units = groupUnits(stales)
    // grouping is a partition: every stale lands in exactly one unit
    expect(units.reduce((sum, unit) => sum + unit.plugins.length, 0)).to.equal(stales.length)

    const groupStats = await measure(() => groupUnits(stales))
    record({
      scenario: 'groupUnits 分组',
      scale: '1000 stale / 每个 closure 100',
      stats: groupStats,
      note: `模块池 5000，changed 1..5 个；本次合并为 ${units.length} 个 unit`,
    })

    expect(groupStats.p50).to.be.below(500)
  })

  it('eviction scope: old vs new (operation counts)', () => {
    const stales = staleSet(1000, 0xc0ffee)
    const units = groupUnits(stales)

    // old behaviour: every stale evicts its whole closure, so the work is the
    // sum of the closure sizes and the footprint is their union
    let legacyWork = 0
    const legacy = new Set<string>()
    for (const stale of stales) {
      legacyWork += stale.closure.size
      for (const url of stale.closure) legacy.add(url)
    }

    // new behaviour: each unit evicts only its scope
    let currentWork = 0
    const current = new Set<string>()
    for (const unit of units) {
      currentWork += unit.scope.size
      for (const url of unit.scope) current.add(url)
    }

    const saved = legacyWork - currentWork
    const ratio = legacyWork ? (saved / legacyWork) * 100 : 0
    const note = `逐 stale 全 closure ${legacyWork} 次 → 逐 unit scope ${currentWork} 次，`
      + `少 evict ${saved} 次（${ratio.toFixed(1)}%）；去重后 ${legacy.size} vs ${current.size}，`
      + `${units.length} 个 unit`
    console.log(`[bench] eviction 范围（操作计数，非耗时）: ${note}`)
    rows.push({ scenario: 'eviction 范围（操作计数，非耗时）', scale: '1000 stale', note })

    // the saving must be real, and the new footprint can never exceed the old one
    expect(currentWork).to.be.lessThan(legacyWork)
    expect(current.size).to.be.at.most(legacy.size)
    expect(current.size).to.be.greaterThan(0)
    // this fixture builds `dependents` per closure instead of over one global
    // graph, so unit scopes may share modules here — the disjointness property
    // is what unit-group.spec.ts covers, not this count
    console.log(`[bench] 注: 本 fixture 的 scope 之和 (${currentWork}) > 并集 (${current.size})，`
      + '说明合成图里 unit 之间仍共享模块；这是 fixture 不满足「单一全局图」导致的，不是被测代码的问题')
  })

  it('writes the report', () => {
    const table = [
      '| 场景 | 规模 | min | p50 | p95 | 备注 |',
      '| --- | --- | ---: | ---: | ---: | --- |',
      ...rows.map(row => `| ${row.scenario} | ${row.scale} | ${
        row.stats ? row.stats.min.toFixed(2) : '—'
      } | ${row.stats ? row.stats.p50.toFixed(2) : '—'} | ${
        row.stats ? row.stats.p95.toFixed(2) : '—'
      } | ${row.note} |`),
    ].join('\n')

    const body = `# HMR 成本基准

由 \`packages/hmr/tests/bench.spec.ts\` 生成，每项 ${ROUNDS} 轮（预热 ${WARMUP} 轮），单位毫秒。
随机数用固定 seed 的 mulberry32，结果可复现。

${table}

## 口径说明

- **时间只覆盖被测函数本身**：\`collectDependencies\` 的 \`linked\` 用普通数组模拟。
  真实 Node 上它是 promise（22 是 promise，24 是数组），每次 \`await\` 都多一次微任务，
  所以这里的数字是遍历成本的下界，不含模块解析开销。
- **eviction 一栏是操作计数，不是耗时对比**。它数的是两种策略各自要 evict 多少个 url：
  「逐 stale 全 closure」的累计次数（旧）对「逐 unit scope」的累计次数（新），
  并同时给出去重后的并集大小。旧实现多 evict 的代价体现在运行时的模块重求值上，
  不在这张表里，本表也不声称旧实现慢多少。
- 该 fixture 按 closure 各自随机连边，不是一张全局图，所以 unit 的 scope 之间仍可能共享模块
  （scope 之和 > 并集）。「unit 之间 scope 不相交」这一性质由 \`unit-group.spec.ts\` 覆盖，
  不是本基准的结论。
- 断言只设宽松上限（1000 节点 < 100ms、10000 节点 < 500ms、1000 stale < 500ms），
  目的是抓挂死而不是抓微回归：CI 机器性能不定，绝对耗时断言会随机变红。
`

    mkdirSync('D:/Work/编程软件/cordis/.research', { recursive: true })
    writeFileSync(OUTPUT, body, 'utf8')
    console.log(`[bench] report written to ${OUTPUT}`)
    expect(rows.length).to.be.greaterThan(0)
  })
})
