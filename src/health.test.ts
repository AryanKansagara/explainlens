import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { analyze, ratioHealth, type Analysis, type Severity } from './analyze.ts'
import { parseLenient } from './parse.ts'
import { SAMPLES } from './samples.ts'

// Issue #4: the Health badge is never better than the worst finding listed under it. Unknown is not healthy.

const run = (text: string) => {
  const { value, warnings } = parseLenient(text)
  return analyze(value, warnings)
}
const fixture = (name: string) => readFileSync(new URL(`../e2e/fixtures/${name}`, import.meta.url), 'utf8')
const RANK: Record<Severity, number> = { bad: 0, warn: 1, info: 2, good: 3 }
/** Health may be worse than the findings say (it starts from the docs-examined ratio), never better. */
const consistent = (a: Analysis) => {
  const worst = a.findings.filter((f) => f.sev === 'bad' || f.sev === 'warn').map((f) => RANK[f.sev])
  return worst.length === 0 || RANK[a.health] <= Math.min(...worst)
}
const IX = `{ stage: 'IXSCAN', indexName: 'a_1', keyPattern: { a: 1 } }`
const es = (n: number, keys: number, docs: number, plan = IX) => `{ queryPlanner: { namespace: 'a.b', winningPlan: ${plan} }, executionStats: { nReturned: ${n}, totalKeysExamined: ${keys}, totalDocsExamined: ${docs}, executionTimeMillis: 3 } }`

test('sample "Aggregation + $lookup": a bad finding means Expensive, not Healthy', () => {
  const a = run(SAMPLES.find((s) => s.id === 'agg')!.text)
  assert.ok(a.findings.some((f) => f.sev === 'bad' && /\$lookup from "customers" on customerId scans the foreign collection/.test(f.title)))
  assert.equal(a.health, 'bad')
  assert.equal(a.docs, 87570240)
  // The docs-examined ratio of the cursor part alone is still 1:1; only the badge changed.
  assert.equal(ratioHealth(a.ratio), 'good')
})

test('every sample, every manual fixture and odd inputs: health is never better than the worst finding', () => {
  const inputs = [
    ...SAMPLES.map((s) => s.text),
    ...['aggregation-explain.txt', 'aggregation-explain-field.txt', 'analyze-query-plan-index.txt', 'analyze-query-plan-no-index.txt'].map(fixture),
    '{"queryPlanner":{}}', '{"stages":[]}', '{"shards":{}}', '{"queryPlanner":{"winningPlan":{"stage":5}}}',
    `{ queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } }`,
    `{ queryPlanner: { winningPlan: { stage: 'EOF', type: 'nonExistentNamespace' } } }`,
    es(5, 5, 5), es(100, 500, 500), es(1, 500, 500), es(1, 5000, 5000), es(0, 0, 0),
    es(1, 1, 1, `{ stage: 'SORT', sortPattern: { a: 1 }, usedDisk: true, spills: 2, inputStage: ${IX} }`),
    es(1, 1, 1, `{ stage: 'AND_SORTED', inputStages: [${IX}, ${IX}] }`),
    `{ queryPlanner: { winningPlan: { stage: 'SHARD_MERGE', shards: [{ shardName: 's1', winningPlan: { stage: 'COLLSCAN' } }, { shardName: 's2', winningPlan: { stage: 'COLLSCAN' } }] } } }`,
    `{ queryPlanner: { winningPlan: ${IX} }, executionStats: { nReturned: 2, totalKeysExamined: 2, totalDocsExamined: 2 } } ... 98 more items`,
    `{ queryPlanner: { namespace: 'a.b', ..., winningPlan: ${IX} }, executionStats: { nReturned: 2, totalKeysExamined: 2, totalDocsExamined: 2 } }`,
  ]
  for (const text of inputs) {
    let a: Analysis
    try { a = run(text) } catch { continue } // inputs that are rejected have no verdict at all
    assert.ok(consistent(a), `${a.health} vs ${a.findings.map((f) => `${f.sev}: ${f.title}`).join(' | ')}`)
  }
})

test('a $lookup that is indexed and a small cursor stay Healthy: nothing was escalated without a finding', () => {
  const a = run(JSON.stringify({ stages: [
    { $cursor: { queryPlanner: { namespace: 'a.b', winningPlan: { stage: 'IXSCAN', indexName: 'x_1', keyPattern: { x: 1 } } }, executionStats: { nReturned: 10, totalDocsExamined: 10, totalKeysExamined: 10, executionTimeMillis: 2 } } },
    { $lookup: { from: 'c', localField: 'x', foreignField: 'y' }, indexesUsed: ['y_1'], totalDocsExamined: 10, totalKeysExamined: 10, collectionScans: 0, nReturned: 10, executionTimeMillisEstimate: 1 },
  ] }))
  assert.equal(a.health, 'good')
})

test('a scanning $lookup behind a 1:1 cursor is Expensive', () => {
  const a = run(JSON.stringify({ stages: [
    { $cursor: { queryPlanner: { namespace: 'a.b', winningPlan: { stage: 'IXSCAN', indexName: 'x_1', keyPattern: { x: 1 } } }, executionStats: { nReturned: 10, totalDocsExamined: 10, totalKeysExamined: 10, executionTimeMillis: 2 } } },
    { $lookup: { from: 'c', localField: 'x', foreignField: 'y' }, indexesUsed: [], totalDocsExamined: 5000, totalKeysExamined: 0, collectionScans: 10, nReturned: 10, executionTimeMillisEstimate: 1 },
  ] }))
  assert.equal(a.health, 'bad')
})

test('the ratio alone still decides when no finding is worse', () => {
  assert.equal(run(es(5, 5, 5)).health, 'good')
  assert.equal(run(es(0, 0, 0)).health, 'good')
  assert.equal(run(es(100, 500, 500)).health, 'warn') // ratio 5
  assert.equal(run(es(1, 500, 500)).health, 'bad') // ratio 500, below the 1,000-document finding threshold
  assert.equal(run(fixture('analyze-query-plan-index.txt')).health, 'good')
})

test('a warn finding caps the badge at Needs attention even for a 1:1 ratio', () => {
  const a = run(es(1, 1, 1, `{ stage: 'AND_SORTED', inputStages: [${IX}, ${IX}] }`))
  assert.equal(a.ratio, 1)
  const a2 = run(es(1, 1, 1, `{ stage: 'SORT', sortPattern: { a: 1 }, usedDisk: true, spills: 2, inputStage: ${IX} }`))
  assert.ok(a2.findings.some((f) => f.sev === 'bad'))
  assert.equal(a2.health, 'bad')
  const a3 = run(es(1, 1, 1, `{ stage: 'SORT', sortPattern: { a: 1 }, inputStage: ${IX} }`))
  assert.ok(a3.findings.some((f) => f.sev === 'warn'))
  assert.equal(a3.health, 'warn')
})

test('docs COLLSCAN excerpt: bad finding, so Expensive (its 6:1 ratio alone would be Needs attention)', () => {
  const a = run(fixture('analyze-query-plan-no-index.txt'))
  assert.ok(a.findings.some((f) => f.sev === 'bad' && f.title === 'Collection scan'))
  assert.equal(ratioHealth(a.ratio), 'warn')
  assert.equal(a.health, 'bad')
})

test('unknown is not healthy: no statistics, no plan', () => {
  assert.equal(run(fixture('aggregation-explain.txt')).health, 'info')
  assert.equal(run(`{ queryPlanner: { namespace: 'a.b', winningPlan: ${IX} } }`).health, 'info')
  for (const text of ['{"queryPlanner":{}}', '{"stages":[]}', '{"shards":{}}']) assert.notEqual(run(text).health, 'good', text)
})

test('ratioHealth grades', () => {
  assert.deepEqual([undefined, 0, 1, 2, 2.01, 10, 10.01, 1e9].map(ratioHealth), ['info', 'good', 'good', 'good', 'warn', 'warn', 'bad', 'bad'])
})

test('"In-memory $sort" does not claim a count when nReturned is unknown', () => {
  const t = run(fixture('aggregation-explain.txt')).findings.map((f) => f.title)
  assert.ok(t.includes('In-memory $sort'))
  assert.ok(!t.some((x) => x.includes('—')))
})

test('"In-memory $sort of N documents" keeps its count, including a real 0', () => {
  const sortTitles = (n: number) => run(JSON.stringify({ stages: [
    { $cursor: { queryPlanner: { namespace: 'a.b', winningPlan: { stage: 'COLLSCAN' } }, executionStats: { nReturned: n, totalDocsExamined: n, executionTimeMillis: 1 } } },
    { $sort: { a: 1 }, nReturned: n, executionTimeMillisEstimate: 1 },
  ] })).findings.map((f) => f.title).filter((x) => x.startsWith('In-memory $sort'))
  assert.deepEqual(sortTitles(31), ['In-memory $sort of 31 documents'])
  assert.deepEqual(sortTitles(0), ['In-memory $sort of 0 documents'])
  assert.ok(run(SAMPLES.find((s) => s.id === 'agg')!.text).findings.some((f) => f.title === 'In-memory $sort of 31 documents'))
})
