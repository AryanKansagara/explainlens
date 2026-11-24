import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { analyze } from './analyze.ts'
import { parseLenient } from './parse.ts'
import { SAMPLES } from './samples.ts'

// Issue #2: a missing execution time is unknown ('—' in the UI), never 0 ms. A reported 0 is still 0.

const run = (text: string) => {
  const { value, warnings } = parseLenient(text)
  return analyze(value, warnings)
}
const fixture = (name: string) => readFileSync(new URL(`../e2e/fixtures/${name}`, import.meta.url), 'utf8')

test('queryPlanner only: time is unknown, not 0', () => {
  assert.equal(run(`{ queryPlanner: { namespace: 'a.b', winningPlan: { stage: 'COLLSCAN' } } }`).ms, undefined)
})

test('the MongoDB manual queryPlanner-only aggregation has no time', () => {
  assert.equal(run(fixture('aggregation-explain.txt')).ms, undefined)
})

test('hand-trimmed executionStats with executionTimeMillis replaced by ... has no time', () => {
  const a = run(`{
    queryPlanner: { namespace: 'a.b', winningPlan: { stage: 'COLLSCAN' } },
    executionStats: { nReturned: 3, executionTimeMillis: '...', totalKeysExamined: 0, totalDocsExamined: 9 }
  }`)
  assert.equal(a.docs, 9)
  assert.equal(a.ms, undefined)
})

test('the trimmed manual excerpt (no executionTimeMillis shown) has no time', () => {
  assert.equal(run(fixture('analyze-query-plan-no-index.txt')).ms, undefined)
})

test('a time that is not a number is unknown, not 0', () => {
  for (const t of ['"fast"', 'null', '{}', '[]', '""']) {
    const a = run(`{ queryPlanner: { winningPlan: { stage: 'COLLSCAN' } }, executionStats: { nReturned: 1, totalDocsExamined: 1, executionTimeMillis: ${t} } }`)
    assert.equal(a.ms, undefined, `executionTimeMillis: ${t}`)
  }
})

test('a reported 0 ms stays 0, in every place a time can come from', () => {
  assert.equal(run(`{ queryPlanner: { winningPlan: { stage: 'COLLSCAN' } }, executionStats: { nReturned: 0, totalDocsExamined: 0, executionTimeMillis: 0 } }`).ms, 0)
  // aggregation: $cursor executionStats and the stage estimates
  const agg = run(`{
    stages: [
      { $cursor: { queryPlanner: { namespace: 'a.b', winningPlan: { stage: 'COLLSCAN' } }, executionStats: { nReturned: 2, executionTimeMillis: 0, totalKeysExamined: 0, totalDocsExamined: 2 } }, nReturned: 2, executionTimeMillisEstimate: 0 },
      { $sort: { a: 1 }, nReturned: 2, executionTimeMillisEstimate: 0 },
    ],
  }`)
  assert.equal(agg.ms, 0)
  assert.equal(run(`{ stages: [ { $sort: { a: 1 }, nReturned: 2, executionTimeMillisEstimate: 0 } ] }`).ms, 0)
})

test('the largest reported time wins, and missing times beside it are ignored', () => {
  const a = run(`{
    stages: [
      { $cursor: { queryPlanner: { namespace: 'a.b', winningPlan: { stage: 'COLLSCAN' } }, executionStats: { nReturned: 2, executionTimeMillis: 7, totalDocsExamined: 2 } }, nReturned: 2 },
      { $sort: { a: 1 }, nReturned: 2, executionTimeMillisEstimate: 12 },
    ],
  }`)
  assert.equal(a.ms, 12)
})

test('samples that carry timings still report them', () => {
  const times = Object.fromEntries(SAMPLES.map((s) => [s.id, run(s.text).ms]))
  assert.equal(times.agg, 41987)
  for (const id of ['collscan', 'esr', 'covered', 'cbr', 'shell']) assert.equal(typeof times[id], 'number', id)
})
