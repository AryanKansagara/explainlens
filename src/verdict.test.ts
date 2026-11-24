import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { analyze } from './analyze.ts'
import { parseLenient } from './parse.ts'
import { SAMPLES } from './samples.ts'

// Issue #3: "No obvious problems" is a verdict. It needs a usable plan AND measured execution numbers; an explain
// with nothing to analyse says so instead.

const run = (text: string) => {
  const { value, warnings } = parseLenient(text)
  return analyze(value, warnings)
}
const fixture = (name: string) => readFileSync(new URL(`../e2e/fixtures/${name}`, import.meta.url), 'utf8')
const titles = (text: string) => run(text).findings.map((f) => f.title)
const IX = `{ stage: 'IXSCAN', indexName: 'a_1', keyPattern: { a: 1 } }`
const withStats = (n: number, keys: number, docs: number) => `{ queryPlanner: { namespace: 'a.b', winningPlan: ${IX} }, executionStats: { nReturned: ${n}, totalKeysExamined: ${keys}, totalDocsExamined: ${docs}, executionTimeMillis: 3 } }`

const EMPTY = [
  ['an empty queryPlanner', '{"queryPlanner":{}}'],
  ['an empty stages array', '{"stages":[]}'],
  ['an empty shards object', '{"shards":{}}'],
  ['shards without content', '{"shards":{"a":{}}}'],
  ['a stage that is a number', '{"queryPlanner":{"winningPlan":{"stage":5}}}'],
  ['an empty stage name', '{"queryPlanner":{"winningPlan":{"stage":""}}}'],
  ['a winningPlan that is a string', '{"queryPlanner":{"winningPlan":"x"}}'],
  ['a winningPlan that is an array', '{"queryPlanner":{"winningPlan":[]}}'],
  ['stages that are not stages', '{"stages":[1,2]}'],
  ['a stage with no $name', '{"stages":[{"foo":1}]}'],
  ['an empty executionStats beside an empty plan', '{"queryPlanner":{},"executionStats":{}}'],
] as const

for (const [name, text] of EMPTY) {
  test(`${name}: "Nothing to analyse", never "No obvious problems" or any good finding`, () => {
    const a = run(text)
    assert.ok(a.findings.some((f) => f.title === 'Nothing to analyse' && f.sev === 'warn'), 'has the Nothing to analyse finding')
    assert.ok(!a.findings.some((f) => f.sev === 'good'), 'no good finding')
    assert.notEqual(a.health, 'good')
  })
}

test('queryPlanner only (the MongoDB manual aggregation): no verdict, the statistics finding stays', () => {
  const a = run(fixture('aggregation-explain.txt'))
  const t = a.findings.map((f) => f.title)
  assert.ok(!t.includes('No obvious problems'))
  assert.ok(!t.includes('Nothing to analyse'), 'there is a real plan here')
  assert.ok(t.includes('No execution statistics'))
  assert.ok(!a.findings.some((f) => f.sev === 'good'))
  assert.equal(a.health, 'info')
})

test('queryPlanner only with a plan that looks fine still gets no green verdict', () => {
  const t = titles(`{ queryPlanner: { namespace: 'a.b', winningPlan: ${IX} } }`)
  assert.deepEqual(t, ['No execution statistics'])
})

test('executionStats whose numbers are all trimmed away gets no verdict', () => {
  const t = titles(`{ queryPlanner: { namespace: 'a.b', winningPlan: ${IX} }, executionStats: { nReturned: '...', totalKeysExamined: '...', totalDocsExamined: '...', executionTimeMillis: '...' } }`)
  assert.ok(!t.includes('No obvious problems'))
})

test('only some numbers reported: no claim about what is examined versus returned', () => {
  for (const es of ['nReturned: 5', 'totalDocsExamined: 5', 'totalKeysExamined: 5', 'executionTimeMillis: 9']) {
    const t = titles(`{ queryPlanner: { namespace: 'a.b', winningPlan: ${IX} }, executionStats: { ${es} } }`)
    assert.ok(!t.includes('No obvious problems'), es)
    assert.ok(!t.includes('Nothing to analyse'), es)
  }
})

test('numbers without any plan are not "nothing", and get no verdict', () => {
  const t = titles(`{ queryPlanner: {}, executionStats: { nReturned: 5, totalKeysExamined: 5, totalDocsExamined: 5, executionTimeMillis: 1 } }`)
  assert.ok(!t.includes('Nothing to analyse'))
  assert.ok(!t.includes('No obvious problems'))
})

test('a plan that reads far more than it returns gets no green verdict even below the finding thresholds', () => {
  // 500 documents for 1 returned: ratio 500 grades the explain "bad", but the finding rules only fire from 1,000.
  const a = run(`{ queryPlanner: { namespace: 'a.b', winningPlan: { stage: 'FETCH', inputStage: ${IX} } }, executionStats: { nReturned: 1, totalKeysExamined: 500, totalDocsExamined: 500, executionTimeMillis: 3 } }`)
  assert.equal(a.health, 'bad')
  assert.ok(!a.findings.some((f) => f.title === 'No obvious problems'))
})

test('a measured, proportionate explain still gets the verdict', () => {
  for (const text of [withStats(5, 5, 5), withStats(0, 0, 0), fixture('analyze-query-plan-index.txt'), SAMPLES.find((s) => s.id === 'covered')!.text]) {
    const a = run(text)
    assert.ok(a.findings.some((f) => f.title === 'No obvious problems' && f.sev === 'good'))
  }
})

test('real problems are never replaced by Nothing to analyse', () => {
  assert.ok(titles(`{ queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } }`).includes('Collection scan'))
  assert.ok(!titles(`{ queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } }`).includes('Nothing to analyse'))
  assert.ok(titles(`{"queryPlanner":{"winningPlan":{"stage":"EOF","type":"nonExistentNamespace"}}}`).includes('Namespace does not exist'))
})

test('aggregation stages alone are something to analyse', () => {
  const t = titles(`{"stages":[{"$match":{"a":1}}]}`)
  assert.ok(!t.includes('Nothing to analyse'))
  assert.ok(!t.includes('No obvious problems'))
})
