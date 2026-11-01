// Realistic explain() outputs modelled on MongoDB 7.0 / 8.0 / 8.3 server responses.
import { parseLenient } from './parse.ts'

const D = (iso: string) => ({ $date: iso })
const serverInfo = (version: string) => ({ host: 'mongo-prod-1', port: 27017, version, gitVersion: '3f1a2c7e9b0d4e6f8a1b2c3d4e5f60718293a4b5' })
const serverParameters = {
  internalQueryFacetBufferSizeBytes: 104857600, internalQueryFacetMaxOutputDocSizeBytes: 104857600,
  internalLookupStageIntermediateDocumentMaxSizeBytes: 104857600, internalDocumentSourceGroupMaxMemoryBytes: 104857600,
  internalQueryMaxBlockingSortMemoryUsageBytes: 104857600, internalQueryProhibitBlockingMergeOnMongoS: 0,
  internalQueryMaxAddToSetBytes: 104857600, internalDocumentSourceSetWindowFieldsMaxMemoryBytes: 104857600,
  internalQueryFrameworkControl: 'trySbeRestricted',
}
const flags = { maxIndexedOrSolutionsReached: false, maxIndexedAndSolutionsReached: false, maxScansToExplodeReached: false }

// (a) Full collection scan + blocking sort.
const collscanFilter = { $and: [{ region: { $eq: 'EU' } }, { status: { $eq: 'pending' } }] }
const collscan = {
  explainVersion: '1',
  queryPlanner: {
    namespace: 'shop.orders', indexFilterSet: false, parsedQuery: collscanFilter,
    queryHash: '6F1B9C0E', planCacheShapeHash: '6F1B9C0E', planCacheKey: 'A2C4E1F7', optimizationTimeMillis: 0, ...flags,
    winningPlan: {
      stage: 'SORT', sortPattern: { createdAt: -1 }, memLimit: 104857600, type: 'simple',
      inputStage: { stage: 'COLLSCAN', filter: collscanFilter, direction: 'forward' },
    },
    rejectedPlans: [],
  },
  executionStats: {
    executionSuccess: true, nReturned: 312, executionTimeMillis: 412, totalKeysExamined: 0, totalDocsExamined: 250000,
    executionStages: {
      stage: 'SORT', nReturned: 312, executionTimeMillisEstimate: 398, works: 250315, advanced: 312, needTime: 250002, needYield: 0,
      saveState: 250, restoreState: 250, isEOF: 1, sortPattern: { createdAt: -1 }, memLimit: 104857600, type: 'simple',
      totalDataSizeSorted: 187200, usedDisk: false, spills: 0, spilledDataStorageSize: 0,
      inputStage: {
        stage: 'COLLSCAN', filter: collscanFilter, nReturned: 312, executionTimeMillisEstimate: 371, works: 250002, advanced: 312,
        needTime: 249689, needYield: 0, saveState: 250, restoreState: 250, isEOF: 1, direction: 'forward', docsExamined: 250000,
      },
    },
  },
  queryShapeHash: '9D3E0A61C2B54F7E8A9B0C1D2E3F405162738495A6B7C8D9E0F1A2B3C4D5E6F7',
  command: { find: 'orders', filter: { status: 'pending', region: 'EU' }, sort: { createdAt: -1 }, $db: 'shop' },
  serverInfo: serverInfo('8.0.4'), serverParameters, ok: 1,
}

// (f) Wrong ESR order: range field before equality field, blocking top-k SORT, with a rejected plan.
// Pasted exactly as mongosh prints it; (b) is the same document as Extended JSON.
const esrShell = `shop> db.orders.find({ status: 'shipped', orderDate: { $gte: ISODate('2024-01-01') } }).sort({ total: -1 }).limit(20).explain('allPlansExecution')
{
  explainVersion: '1',
  queryPlanner: {
    namespace: 'shop.orders',
    indexFilterSet: false,
    parsedQuery: {
      '$and': [
        { status: { '$eq': 'shipped' } },
        { orderDate: { '$gte': ISODate('2024-01-01T00:00:00.000Z') } }
      ]
    },
    queryHash: '2B7F4D1A',
    planCacheShapeHash: '2B7F4D1A',
    planCacheKey: 'C81E2A90',
    optimizationTimeMillis: 1,
    maxIndexedOrSolutionsReached: false,
    maxIndexedAndSolutionsReached: false,
    maxScansToExplodeReached: false,
    winningPlan: {
      stage: 'SORT',
      sortPattern: { total: -1 },
      memLimit: 104857600,
      limitAmount: 20,
      type: 'simple',
      inputStage: {
        stage: 'FETCH',
        inputStage: {
          stage: 'IXSCAN',
          keyPattern: { orderDate: 1, status: 1 },
          indexName: 'orderDate_1_status_1',
          isMultiKey: false,
          multiKeyPaths: { orderDate: [], status: [] },
          isUnique: false,
          isSparse: false,
          isPartial: false,
          indexVersion: 2,
          direction: 'forward',
          indexBounds: {
            orderDate: [ '[new Date(1704067200000), new Date(9223372036854775807)]' ],
            status: [ '["shipped", "shipped"]' ]
          }
        }
      }
    },
    rejectedPlans: [
      {
        stage: 'SORT',
        sortPattern: { total: -1 },
        memLimit: 104857600,
        limitAmount: 20,
        type: 'simple',
        inputStage: {
          stage: 'FETCH',
          filter: { orderDate: { '$gte': ISODate('2024-01-01T00:00:00.000Z') } },
          inputStage: {
            stage: 'IXSCAN',
            keyPattern: { status: 1 },
            indexName: 'status_1',
            isMultiKey: false,
            multiKeyPaths: { status: [] },
            isUnique: false,
            isSparse: false,
            isPartial: false,
            indexVersion: 2,
            direction: 'forward',
            indexBounds: { status: [ '["shipped", "shipped"]' ] }
          }
        }
      }
    ]
  },
  executionStats: {
    executionSuccess: true,
    nReturned: 20,
    executionTimeMillis: 286,
    totalKeysExamined: 48210,
    totalDocsExamined: 12044,
    executionStages: {
      stage: 'SORT',
      nReturned: 20,
      executionTimeMillisEstimate: 271,
      works: 48232,
      advanced: 20,
      needTime: 48211,
      needYield: 0,
      saveState: 51,
      restoreState: 51,
      isEOF: 1,
      sortPattern: { total: -1 },
      memLimit: 104857600,
      limitAmount: 20,
      type: 'simple',
      totalDataSizeSorted: 5420,
      usedDisk: false,
      spills: 0,
      spilledDataStorageSize: 0,
      inputStage: {
        stage: 'FETCH',
        nReturned: 12044,
        executionTimeMillisEstimate: 248,
        works: 48211,
        advanced: 12044,
        needTime: 36166,
        needYield: 0,
        saveState: 51,
        restoreState: 51,
        isEOF: 1,
        docsExamined: 12044,
        alreadyHasObj: 0,
        inputStage: {
          stage: 'IXSCAN',
          nReturned: 12044,
          executionTimeMillisEstimate: 94,
          works: 48211,
          advanced: 12044,
          needTime: 36166,
          needYield: 0,
          saveState: 51,
          restoreState: 51,
          isEOF: 1,
          keyPattern: { orderDate: 1, status: 1 },
          indexName: 'orderDate_1_status_1',
          isMultiKey: false,
          multiKeyPaths: { orderDate: [], status: [] },
          isUnique: false,
          isSparse: false,
          isPartial: false,
          indexVersion: 2,
          direction: 'forward',
          indexBounds: {
            orderDate: [ '[new Date(1704067200000), new Date(9223372036854775807)]' ],
            status: [ '["shipped", "shipped"]' ]
          },
          keysExamined: 48210,
          seeks: 36167,
          dupsTested: 0,
          dupsDropped: 0
        }
      }
    },
    allPlansExecution: [
      {
        nReturned: 0,
        executionTimeMillisEstimate: 38,
        totalKeysExamined: 10001,
        totalDocsExamined: 2494,
        executionStages: {
          stage: 'SORT', nReturned: 0, executionTimeMillisEstimate: 38, works: 10001, advanced: 0, needTime: 10001, isEOF: 0,
          sortPattern: { total: -1 }, memLimit: 104857600, limitAmount: 20, type: 'simple', totalDataSizeSorted: 0, usedDisk: false, spills: 0,
          inputStage: {
            stage: 'FETCH', nReturned: 2494, works: 10001, advanced: 2494, docsExamined: 2494, alreadyHasObj: 0,
            inputStage: { stage: 'IXSCAN', nReturned: 2494, works: 10001, advanced: 2494, indexName: 'orderDate_1_status_1', keysExamined: 10001, seeks: 7508 }
          }
        }
      },
      {
        nReturned: 0,
        executionTimeMillisEstimate: 51,
        totalKeysExamined: 10001,
        totalDocsExamined: 10001,
        executionStages: {
          stage: 'SORT', nReturned: 0, executionTimeMillisEstimate: 51, works: 10001, advanced: 0, needTime: 10001, isEOF: 0,
          sortPattern: { total: -1 }, memLimit: 104857600, limitAmount: 20, type: 'simple', totalDataSizeSorted: 0, usedDisk: false, spills: 0,
          inputStage: {
            stage: 'FETCH', filter: { orderDate: { '$gte': ISODate('2024-01-01T00:00:00.000Z') } }, nReturned: 3311, works: 10001, advanced: 3311, docsExamined: 10001,
            inputStage: { stage: 'IXSCAN', nReturned: 10001, works: 10001, advanced: 10001, indexName: 'status_1', keysExamined: 10001, seeks: 1 }
          }
        }
      }
    ]
  },
  queryShapeHash: '41C6A0F2D9B8E7C6A5B4C3D2E1F0A9B8C7D6E5F4A3B2C1D0E9F8A7B6C5D4E3F2',
  command: {
    find: 'orders',
    filter: { status: 'shipped', orderDate: { '$gte': ISODate('2024-01-01T00:00:00.000Z') } },
    sort: { total: -1 },
    limit: 20,
    '$db': 'shop'
  },
  serverInfo: {
    host: 'mongo-prod-1',
    port: 27017,
    version: '8.0.4',
    gitVersion: '3f1a2c7e9b0d4e6f8a1b2c3d4e5f60718293a4b5'
  },
  ok: 1,
  '$clusterTime': {
    clusterTime: Timestamp({ t: 1730390400, i: 12 }),
    signature: {
      hash: Binary.createFromBase64('AAAAAAAAAAAAAAAAAAAAAAAAAAA=', 0),
      keyId: Long('0')
    }
  },
  operationTime: Timestamp({ t: 1730390400, i: 12 })
}`

// (c) Covered query: IXSCAN feeds PROJECTION_COVERED, zero documents fetched.
const coveredIx = {
  stage: 'IXSCAN', keyPattern: { sku: 1, qty: 1 }, indexName: 'sku_1_qty_1', isMultiKey: false, multiKeyPaths: { sku: [], qty: [] },
  isUnique: false, isSparse: false, isPartial: false, indexVersion: 2, direction: 'forward',
  indexBounds: { sku: ['["ABC-123", "ABC-123"]'], qty: ['[MinKey, MaxKey]'] },
}
const covered = {
  explainVersion: '1',
  queryPlanner: {
    namespace: 'shop.inventory', indexFilterSet: false, parsedQuery: { sku: { $eq: 'ABC-123' } },
    queryHash: '8E21C0B4', planCacheShapeHash: '8E21C0B4', planCacheKey: '5D0F7A13', optimizationTimeMillis: 0, ...flags,
    winningPlan: { stage: 'PROJECTION_COVERED', transformBy: { _id: 0, sku: 1, qty: 1 }, inputStage: coveredIx },
    rejectedPlans: [],
  },
  executionStats: {
    executionSuccess: true, nReturned: 3, executionTimeMillis: 0, totalKeysExamined: 3, totalDocsExamined: 0,
    executionStages: {
      stage: 'PROJECTION_COVERED', nReturned: 3, executionTimeMillisEstimate: 0, works: 4, advanced: 3, needTime: 0, needYield: 0,
      saveState: 0, restoreState: 0, isEOF: 1, transformBy: { _id: 0, sku: 1, qty: 1 },
      inputStage: { ...coveredIx, nReturned: 3, executionTimeMillisEstimate: 0, works: 4, advanced: 3, needTime: 0, needYield: 0, saveState: 0, restoreState: 0, isEOF: 1, keysExamined: 3, seeks: 1, dupsTested: 0, dupsDropped: 0 },
    },
  },
  queryShapeHash: 'B7E1D2C3A4F5E6D7C8B9A0F1E2D3C4B5A6F7E8D9C0B1A2F3E4D5C6B7A8F9E0D1',
  command: { find: 'inventory', filter: { sku: 'ABC-123' }, projection: { _id: 0, sku: 1, qty: 1 }, $db: 'shop' },
  serverInfo: serverInfo('8.0.4'), serverParameters, ok: 1,
}

// (d) Aggregation: $match absorbed into $cursor, correlated $lookup with an unindexed foreignField, $group, $sort.
const aggIx = {
  stage: 'IXSCAN', keyPattern: { status: 1, createdAt: 1 }, indexName: 'status_1_createdAt_1', isMultiKey: false,
  multiKeyPaths: { status: [], createdAt: [] }, isUnique: false, isSparse: false, isPartial: false, indexVersion: 2, direction: 'forward',
  indexBounds: { status: ['["delivered", "delivered"]'], createdAt: ['[new Date(1735689600000), new Date(9223372036854775807)]'] },
}
const aggFilter = { $and: [{ status: { $eq: 'delivered' } }, { createdAt: { $gte: D('2025-01-01T00:00:00.000Z') } }] }
const pipeline = [
  { $match: { status: 'delivered', createdAt: { $gte: D('2025-01-01T00:00:00.000Z') } } },
  { $lookup: { from: 'customers', localField: 'customerId', foreignField: 'customerId', as: 'customer', pipeline: [{ $project: { tier: 1, country: 1 } }] } },
  { $unwind: '$customer' },
  { $group: { _id: '$customer.country', revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
  { $sort: { revenue: -1 } },
]
const aggregation = {
  explainVersion: '1',
  stages: [
    {
      $cursor: {
        queryPlanner: {
          namespace: 'shop.orders', indexFilterSet: false, parsedQuery: aggFilter,
          queryHash: 'E4A19B07', planCacheShapeHash: 'E4A19B07', planCacheKey: '0B6D2F95', optimizationTimeMillis: 1, ...flags,
          winningPlan: {
            stage: 'PROJECTION_SIMPLE', transformBy: { customerId: 1, total: 1, _id: 0 },
            inputStage: { stage: 'FETCH', inputStage: aggIx },
          },
          rejectedPlans: [],
        },
        executionStats: {
          executionSuccess: true, nReturned: 18240, executionTimeMillis: 41987, totalKeysExamined: 18240, totalDocsExamined: 18240,
          executionStages: {
            stage: 'PROJECTION_SIMPLE', nReturned: 18240, executionTimeMillisEstimate: 63, works: 18241, advanced: 18240, needTime: 0, needYield: 0,
            saveState: 1230, restoreState: 1230, isEOF: 1, transformBy: { customerId: 1, total: 1, _id: 0 },
            inputStage: {
              stage: 'FETCH', nReturned: 18240, executionTimeMillisEstimate: 58, works: 18241, advanced: 18240, needTime: 0, needYield: 0,
              saveState: 1230, restoreState: 1230, isEOF: 1, docsExamined: 18240, alreadyHasObj: 0,
              inputStage: { ...aggIx, nReturned: 18240, executionTimeMillisEstimate: 12, works: 18241, advanced: 18240, needTime: 0, needYield: 0, saveState: 1230, restoreState: 1230, isEOF: 1, keysExamined: 18240, seeks: 1, dupsTested: 0, dupsDropped: 0 },
            },
          },
        },
      },
      nReturned: 18240, executionTimeMillisEstimate: 71,
    },
    {
      $lookup: {
        from: 'customers', as: 'customer', localField: 'customerId', foreignField: 'customerId', let: {},
        pipeline: [{ $project: { tier: 1, country: 1, _id: 1 } }], unwinding: { preserveNullAndEmptyArrays: false },
      },
      totalDocsExamined: 87552000, totalKeysExamined: 0, collectionScans: 18240, indexesUsed: [],
      nReturned: 18240, executionTimeMillisEstimate: 41872,
    },
    {
      $group: { _id: '$customer.country', revenue: { $sum: '$total' }, orders: { $sum: { $const: 1 } } },
      maxAccumulatorMemoryUsageBytes: { revenue: 2976, orders: 2976 }, totalOutputDataSizeBytes: 9144,
      usedDisk: false, spills: 0, spilledDataStorageSize: 0, spilledBytes: 0, spilledRecords: 0,
      nReturned: 31, executionTimeMillisEstimate: 41950,
    },
    {
      $sort: { sortKey: { revenue: -1 } }, totalDataSizeSortedBytesEstimate: 10168, usedDisk: false, spills: 0, spilledDataStorageSize: 0,
      nReturned: 31, executionTimeMillisEstimate: 41950,
    },
  ],
  queryShapeHash: '0A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F9',
  serverInfo: serverInfo('8.0.4'), serverParameters,
  command: { aggregate: 'orders', pipeline, cursor: {}, $db: 'shop' },
  ok: 1,
}

// (e) MongoDB 8.3: pipeline fully pushed down to SBE, plan chosen by the cost-based ranker (costEstimate / cardinalityEstimate).
const sbeFilterCountry = { 'dest.country': { $eq: 'DE' } }
const sbeFilterStatus = { status: { $eq: 'delayed' } }
const sbe = {
  explainVersion: '2',
  queryPlanner: {
    namespace: 'logistics.shipments', indexFilterSet: false, parsedQuery: { $and: [{ 'dest.country': { $eq: 'DE' } }, { status: { $eq: 'delayed' } }] },
    planCacheShapeHash: '7C3D90E2', planCacheKey: '1FA6B83C', optimizationTimeMillis: 3, ...flags,
    winningPlan: {
      isCached: false,
      queryPlan: {
        stage: 'GROUP', planNodeId: 3, costEstimate: 1180.94, cardinalityEstimate: 7, estimatesMetadata: { ceSource: 'heuristics' },
        inputStage: {
          stage: 'FETCH', planNodeId: 2, filter: sbeFilterCountry, costEstimate: 1162.31, cardinalityEstimate: 104.2, numDocsEstimate: 1150,
          estimatesMetadata: { ceSource: 'sampling' },
          inputStage: {
            stage: 'IXSCAN', planNodeId: 1, keyPattern: { status: 1, createdAt: -1 }, indexName: 'status_1_createdAt_-1', isMultiKey: false,
            multiKeyPaths: { status: [], createdAt: [] }, isUnique: false, isSparse: false, isPartial: false, indexVersion: 2, direction: 'forward',
            indexBounds: { status: ['["delayed", "delayed"]'], createdAt: ['[MaxKey, MinKey]'] },
            costEstimate: 410.66, cardinalityEstimate: 1150, numKeysEstimate: 1150, filterNumKeysEstimate: 1150, estimatesMetadata: { ceSource: 'sampling' },
          },
        },
      },
      slotBasedPlan: {
        slots: '$$RESULT=s15 env: { s1 = TimeZoneDatabase(Asia/Kolkata...Europe/Berlin) (timeZoneDB), s2 = Nothing (SEARCH_META), s3 = 1730390400000 (NOW) }',
        stages: "[3] project [s15 = newBsonObj(\"_id\", s11, \"n\", s12, \"avgDelayH\", s14)] \n[3] project [s14 = (s13 / s12)] \n[3] group [s11] [s12 = sum(1), s13 = sum(s10)] spillSlots[s16, s17] mergingExprs[sum(s16), sum(s17)] \n[3] project [s11 = getField(s8, \"carrier\"), s10 = getField(s8, \"delayHours\")] \n[2] filter {traverseF(getField(s9, \"country\"), lambda(l1.0) { ((l1.0 == \"DE\") ?: false) }, false)} \n[2] project [s9 = getField(s8, \"dest\")] \n[2] nlj inner [] [s4, s5, s6, s7] \n    left \n        [1] ixseek KS(3C64656C61796564000A0104) KS(3C64656C61796564000A01FE) s7 s4 s5 s6 [] @\"b1f0c2d4-9e3a-4c55-a2f1-7d8e9c0b1a2f\" @\"status_1_createdAt_-1\" true \n    right \n        [2] limit 1ll \n        [2] seek s4 s8 s2 s5 s6 s7 [] @\"b1f0c2d4-9e3a-4c55-a2f1-7d8e9c0b1a2f\" true false \n",
      },
    },
    rejectedPlans: [
      {
        isCached: false,
        queryPlan: {
          stage: 'GROUP', planNodeId: 3, costEstimate: 6212.4, cardinalityEstimate: 7, estimatesMetadata: { ceSource: 'heuristics' },
          inputStage: {
            stage: 'FETCH', planNodeId: 2, filter: sbeFilterStatus, costEstimate: 6188.02, cardinalityEstimate: 104.2, numDocsEstimate: 9400,
            estimatesMetadata: { ceSource: 'sampling' },
            inputStage: {
              stage: 'IXSCAN', planNodeId: 1, keyPattern: { 'dest.country': 1 }, indexName: 'dest.country_1', isMultiKey: false,
              multiKeyPaths: { 'dest.country': [] }, isUnique: false, isSparse: false, isPartial: false, indexVersion: 2, direction: 'forward',
              indexBounds: { 'dest.country': ['["DE", "DE"]'] },
              costEstimate: 3356.8, cardinalityEstimate: 9400, numKeysEstimate: 9400, filterNumKeysEstimate: 9400, estimatesMetadata: { ceSource: 'sampling' },
            },
          },
        },
        slotBasedPlan: { slots: '$$RESULT=s15 env: { s1 = TimeZoneDatabase(...) (timeZoneDB), s2 = Nothing (SEARCH_META) }', stages: '[3] project [...] \n[3] group [s11] [...] \n[2] filter {...} \n[2] nlj inner [] [s4, s5, s6, s7] \n    left \n        [1] ixseek ... @"dest.country_1" true \n    right \n        [2] limit 1ll \n        [2] seek ... \n' },
      },
    ],
  },
  executionStats: {
    executionSuccess: true, nReturned: 7, executionTimeMillis: 104, totalKeysExamined: 23800, totalDocsExamined: 23800,
    executionStages: {
      stage: 'project', planNodeId: 3, nReturned: 7, executionTimeMillisEstimate: 96, opens: 1, closes: 1, saveState: 24, restoreState: 24, isEOF: 1,
      projections: { 15: 'newBsonObj("_id", s11, "n", s12, "avgDelayH", s14) ' },
      inputStage: {
        stage: 'group', planNodeId: 3, nReturned: 7, executionTimeMillisEstimate: 96, opens: 1, closes: 1, saveState: 24, restoreState: 24, isEOF: 1,
        groupBySlots: [11], expressions: { 12: 'sum(1) ', 13: 'sum(s10) ' }, mergingExprs: { 16: 'sum(s16) ', 17: 'sum(s17) ' },
        usedDisk: false, spills: 0, spilledBytes: 0, spilledRecords: 0, spilledDataStorageSize: 0, peakTrackedMemBytes: 1696,
        inputStage: {
          stage: 'filter', planNodeId: 2, nReturned: 2140, executionTimeMillisEstimate: 95, opens: 1, closes: 1, saveState: 24, restoreState: 24, isEOF: 1, numTested: 23800,
          filter: 'traverseF(getField(s9, "country"), lambda(l1.0) { ((l1.0 == "DE") ?: false) }, false) ',
          inputStage: {
            stage: 'nlj', planNodeId: 2, nReturned: 23800, executionTimeMillisEstimate: 91, opens: 1, closes: 1, saveState: 24, restoreState: 24, isEOF: 1,
            totalDocsExamined: 23800, totalKeysExamined: 23800, collectionScans: 0, collectionSeeks: 23800, indexScans: 0, indexSeeks: 1,
            indexesUsed: ['status_1_createdAt_-1'], innerOpens: 23800, innerCloses: 1, outerProjects: [], outerCorrelated: [4, 5, 6, 7],
            outerStage: {
              stage: 'ixseek', planNodeId: 1, nReturned: 23800, executionTimeMillisEstimate: 30, opens: 1, closes: 1, saveState: 24, restoreState: 24, isEOF: 1,
              indexName: 'status_1_createdAt_-1', keysExamined: 23800, seeks: 1, numReads: 23801, indexKeySlot: 7, recordIdSlot: 4, snapshotIdSlot: 5, indexIdentSlot: 6, outputSlots: [], indexKeysToInclude: '00000000000000000000000000000000',
              seekKeyLow: 'KS(3C64656C61796564000A0104) ', seekKeyHigh: 'KS(3C64656C61796564000A01FE) ',
            },
            innerStage: {
              stage: 'limit', planNodeId: 2, nReturned: 23800, executionTimeMillisEstimate: 56, opens: 23800, closes: 1, saveState: 24, restoreState: 24, isEOF: 1, limit: 1,
              inputStage: { stage: 'seek', planNodeId: 2, nReturned: 23800, executionTimeMillisEstimate: 55, opens: 23800, closes: 1, saveState: 24, restoreState: 24, isEOF: 0, numReads: 23800, recordSlot: 8, recordIdSlot: 4, fields: [], outputSlots: [] },
            },
          },
        },
      },
    },
  },
  queryShapeHash: '5E4D3C2B1A0F9E8D7C6B5A4F3E2D1C0B9A8F7E6D5C4B3A2F1E0D9C8B7A6F5E4D',
  command: {
    aggregate: 'shipments',
    pipeline: [
      { $match: { status: 'delayed', 'dest.country': 'DE' } },
      { $group: { _id: '$carrier', n: { $sum: 1 }, avgDelayH: { $avg: '$delayHours' } } },
    ],
    cursor: {}, $db: 'logistics',
  },
  serverInfo: { ...serverInfo('8.3.3'), host: 'mongo-analytics-2' },
  serverParameters: { ...serverParameters, internalQueryFrameworkControl: 'trySbeEngine' },
  ok: 1,
}

const json = (o: unknown) => JSON.stringify(o, null, 2)

export const SAMPLES: { id: string; label: string; text: string }[] = [
  { id: 'collscan', label: 'COLLSCAN + sort', text: json(collscan) },
  { id: 'esr', label: 'Wrong ESR order', text: json(parseLenient(esrShell).value) },
  { id: 'covered', label: 'Covered query', text: json(covered) },
  { id: 'agg', label: 'Aggregation + $lookup', text: json(aggregation) },
  { id: 'cbr', label: '8.3 SBE + cost estimates', text: json(sbe) },
  { id: 'shell', label: 'mongosh paste', text: esrShell },
]
