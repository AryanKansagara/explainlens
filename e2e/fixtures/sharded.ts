// SYNTHETIC sharded find() explain. The shape follows the "Sharded Collections" layouts documented at
// https://www.mongodb.com/docs/manual/reference/explain-results/ (queryPlanner.winningPlan.shards[] with
// shardName / namespace / parsedQuery / winningPlan / rejectedPlans, and executionStats.executionStages.shards[]
// with shardName / executionSuccess / executionStages). Names and numbers are made up; it is not captured output.
const shardPlan = (shardName: string) => ({
  shardName,
  connectionString: `${shardName}/localhost:27018`,
  namespace: 'shop.orders',
  indexFilterSet: false,
  parsedQuery: { status: { $eq: 'open' } },
  winningPlan: { stage: 'SHARDING_FILTER', inputStage: { stage: 'COLLSCAN', filter: { status: { $eq: 'open' } }, direction: 'forward' } },
  rejectedPlans: [],
})

const shardExec = (shardName: string, scanned: number, returned: number) => ({
  shardName,
  executionSuccess: true,
  executionStages: {
    stage: 'SHARDING_FILTER',
    nReturned: returned,
    executionTimeMillisEstimate: 4,
    chunkSkips: 0,
    inputStage: {
      stage: 'COLLSCAN',
      nReturned: returned,
      executionTimeMillisEstimate: 3,
      docsExamined: scanned,
      filter: { status: { $eq: 'open' } },
      direction: 'forward',
    },
  },
})

export const shardedFind = {
  queryPlanner: {
    mongosPlannerVersion: 1,
    winningPlan: { stage: 'SHARD_MERGE', shards: [shardPlan('shardA'), shardPlan('shardB')] },
  },
  executionStats: {
    nReturned: 30,
    executionTimeMillis: 9,
    totalKeysExamined: 0,
    totalDocsExamined: 5000,
    executionStages: {
      stage: 'SHARD_MERGE',
      nReturned: 30,
      executionTimeMillis: 9,
      totalKeysExamined: 0,
      totalDocsExamined: 5000,
      shards: [shardExec('shardA', 3000, 20), shardExec('shardB', 2000, 10)],
    },
  },
  command: { find: 'orders', filter: { status: 'open' }, $db: 'shop' },
  ok: 1,
}
