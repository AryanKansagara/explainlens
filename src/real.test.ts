// Excerpts that follow the exact layout of real mongosh explain() output published in the MongoDB
// manual's tested examples (sample_mflix dataset, MongoDB 8.2): string concatenation for long SBE
// strings, Long('...') wrappers, '...' placeholders and bare ... lines used when output is trimmed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze } from './analyze.ts'
import { parseLenient } from './parse.ts'

const run = (s: string) => {
  const { value, warnings } = parseLenient(s)
  return { a: analyze(value, warnings), warnings }
}

const NO_INDEX = `{
  queryPlanner: {
    namespace: 'sample_mflix.movies',
    winningPlan: {
      stage: 'COLLSCAN',
      '...': '...'
    },
    '...': '...'
  },
  executionStats: {
    executionSuccess: true,
    nReturned: 3809,
    totalKeysExamined: 0,
    totalDocsExamined: 21349,
    executionStages: {
      stage: 'COLLSCAN',
      '...': '...'
    },
    '...': '...'
  },
  '...': '...'
}`

const AGG = `{
  explainVersion: '2',
  stages: [
    {
      '$cursor': {
        queryPlanner: {
          namespace: 'sample_mflix.comments',
          parsedQuery: { date: { '$gte': ISODate('2015-01-01T00:00:00.000Z') } },
          winningPlan: {
            isCached: false,
            queryPlan: {
              stage: 'GROUP',
              planNodeId: 3,
              inputStage: {
                stage: 'COLLSCAN',
                planNodeId: 1,
                filter: {
                  date: { '$gte': ISODate('2015-01-01T00:00:00.000Z') }
                },
                direction: 'forward'
              }
            },
            slotBasedPlan: {
              slots: '$$RESULT=s9 env: {  }',
              stages: '[3] project [s9 = newObj("_id", s6, "commentCount", s8)] \\n' +
                '[3] group [s6] [s7 = count()] spillSlots[s5] mergingExprs[sum(s5)] \\n' +
                '[1] scan s1 s2 none none none none none none [s3 = movie_id, s4 = date] true false '
            }
          },
          rejectedPlans: []
        },
        executionStats: {
          executionSuccess: true,
          nReturned: 697,
          executionTimeMillis: 31,
          totalKeysExamined: 0,
          totalDocsExamined: 41079,
          executionStages: {
            stage: 'group',
            planNodeId: 3,
            nReturned: 697,
            executionTimeMillisEstimate: 28,
            groupBySlots: [ Long('6') ],
            usedDisk: false,
            spills: 0,
            inputStage: {
              stage: 'filter',
              planNodeId: 1,
              nReturned: 2303,
              executionTimeMillisEstimate: 28,
              numTested: 41079,
              inputStage: {
                stage: 'scan',
                planNodeId: 1,
                nReturned: 41079,
                executionTimeMillisEstimate: 28,
                numReads: 41079,
                scanFieldSlots: [ Long('3'), Long('4') ]
              }
            }
          },
          allPlansExecution: []
        }
      },
      nReturned: Long('697'),
      executionTimeMillisEstimate: Long('31')
    },
    {
      '$sort': { sortKey: { commentCount: -1 } },
      totalDataSizeSortedBytesEstimate: Long('170765'),
      usedDisk: false,
      spills: Long('0'),
      nReturned: Long('697'),
      executionTimeMillisEstimate: Long('31')
    }
  ],
  serverInfo: { host: 'localhost', port: 27017, version: '8.2.2' },
  command: {
    aggregate: 'comments',
    pipeline: [
      {
        '$match': { date: { '$gte': ISODate('2015-01-01T00:00:00.000Z') } }
      },
      { '$group': { _id: '$movie_id', commentCount: { '$sum': 1 } } },
      { '$sort': { commentCount: -1 } }
    ],
    cursor: {},
    '$db': 'sample_mflix'
  },
  ok: 1
}`

test('mongosh string concatenation is joined into one string', () => {
  const { value } = parseLenient(`{ s: 'a\\n' +\n   'b' + "c" }`)
  assert.equal((value as any).s, 'a\nbc')
})

test('a stray + that is not followed by a string is a clear error', () => {
  assert.throws(() => parseLenient(`{ s: 'a' + 5 }`), /Expected a string after "\+"/)
})

test('docs COLLSCAN excerpt: 21,349 examined for 3,809 returned', () => {
  const { a } = run(NO_INDEX)
  assert.equal(a.namespace, 'sample_mflix.movies')
  assert.equal(a.docs, 21349)
  assert.equal(a.nReturned, 3809)
  assert.equal(a.verbosity, 'executionStats')
  assert.ok(Math.abs(a.ratio! - 21349 / 3809) < 1e-9)
  // The 6:1 ratio alone would grade this 'warn', but the Collection scan finding is 'bad' and Health may not be better than that.
  assert.equal(a.health, 'bad')
  assert.ok(a.findings.some((f) => f.sev === 'bad' && f.title === 'Collection scan'))
})

test('real 8.2 SBE aggregation: GROUP pushed down over COLLSCAN, stats merged by planNodeId', () => {
  const { a } = run(AGG)
  assert.equal(a.version, '8.2.2')
  assert.equal(a.engine, 'SBE (slot-based)')
  assert.deepEqual(a.pipeline.map((s) => s.name), ['$cursor', '$sort'])
  const tree = a.parts[0].tree!
  assert.equal(tree.stage, 'GROUP')
  assert.equal(tree.nReturned, 697)
  assert.equal(tree.children[0].stage, 'COLLSCAN')
  assert.equal(tree.children[0].docs, 41079)
  assert.equal(a.docs, 41079)
  assert.equal(a.nReturned, 697)
  assert.equal(a.index?.command, 'db.comments.createIndex({ date: 1 })')
  assert.ok(a.findings.some((f) => /In-memory \$sort of 697/.test(f.title)))
})

test('hand-trimmed bare ... lines in objects and arrays are skipped with an info note', () => {
  const src = `{
    queryPlanner: {
      namespace: 'db.c',
      ...
      winningPlan: { stage: 'OR', inputStages: [ { stage: 'IXSCAN', indexName: 'a_1', ... }, { stage: 'IXSCAN', indexName: 'b_1' }, ... ] },
    },
    ...
  }`
  const { a, warnings } = run(src)
  assert.equal(a.parts[0].tree!.children.length, 2)
  assert.match(warnings[0], /trimmed by hand/)
  assert.ok(a.findings.some((f) => f.title === 'Output was trimmed' && f.sev === 'info'))
  assert.ok(!a.findings.some((f) => f.title === 'Shell output was truncated'))
})

test('"... N more items" still reports shell truncation', () => {
  const { warnings } = parseLenient(`{ a: [ 1, 2, ... 98 more items ] }`)
  assert.match(warnings[0], /cut short by the shell/)
})

test('canonical Extended JSON (Compass raw output / EJSON.stringify) numbers normalize', () => {
  const { a } = run(JSON.stringify({
    queryPlanner: { namespace: 'db.c', winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'year_1', keyPattern: { year: { $numberInt: '1' } } } } },
    executionStats: { nReturned: { $numberInt: '235' }, totalKeysExamined: { $numberLong: '246' }, totalDocsExamined: { $numberInt: '235' }, executionTimeMillis: { $numberInt: '2' } },
  }))
  assert.equal(a.keys, 246)
  assert.equal(a.docs, 235)
  assert.equal(a.health, 'good')
})

test('a ratio that lowers health is always explained by a finding', () => {
  const plan = (docs: number, ret: number) => analyze({ queryPlanner: { namespace: 'a.b', winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', keyPattern: { a: 1 }, indexName: 'a_1' } } }, executionStats: { nReturned: ret, totalDocsExamined: docs, totalKeysExamined: ret, executionTimeMillis: 1 } })
  for (const [docs, ret] of [[50, 10], [30, 10], [100, 10], [50, 1], [90, 1]]) {
    const a = plan(docs, ret)
    assert.notEqual(a.health, 'good')
    assert.ok(a.findings.some((f) => f.sev === 'warn' || f.sev === 'bad'), `${docs}/${ret}`)
  }
  assert.ok(plan(10, 10).findings.every((f) => f.sev !== 'warn' && f.sev !== 'bad'))
})
