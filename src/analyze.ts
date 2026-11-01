// Turns raw explain() output (classic, SBE, aggregation, sharded, 8.3 cost-based ranker) into a plan tree, findings and index advice.
import { fmt, show, type Obj } from './parse.ts'

export type Severity = 'bad' | 'warn' | 'info' | 'good'
export type Finding = { sev: Severity; title: string; detail: string; doc?: string; fix?: string }

export type PlanNode = {
  id: string
  stage: string
  label?: string
  d: Obj
  children: PlanNode[]
  nReturned?: number
  ms?: number
  selfMs?: number
  keys?: number
  docs?: number
  works?: number
  cost?: number
  card?: number
  ceSource?: string
  heat: number
}

export type PlanRow = {
  name: string
  winner: boolean
  shape: string
  indexes: string[]
  sort: boolean
  fetch: boolean
  cached?: boolean
  cost?: number
  card?: number
  nReturned?: number
  keys?: number
  docs?: number
  works?: number
  advanced?: number
  ms?: number
  score?: number
  eof?: boolean
}

export type QueryPart = {
  label: string
  namespace?: string
  engine: 'classic' | 'sbe'
  tree: PlanNode | null
  plans: PlanRow[]
  why: string[]
  parsedQuery?: Obj
  nReturned?: number
  keys?: number
  docs?: number
  ms?: number
}

export type PipeStage = { name: string; spec: unknown; d: Obj; nReturned?: number; ms?: number; shard?: string }

export type IndexAdvice = {
  keys: [string, number][]
  command: string
  eq: string[]
  sort: string[]
  range: string[]
  notes: string[]
  current?: string
  matchesCurrent: boolean
}

export type Analysis = {
  namespace?: string
  engine: string
  verbosity: 'queryPlanner' | 'executionStats' | 'allPlansExecution'
  version?: string
  aggregation: boolean
  sharded: boolean
  nReturned?: number
  docs?: number
  keys?: number
  ms?: number
  ratio?: number
  health: Severity
  parts: QueryPart[]
  pipeline: PipeStage[]
  findings: Finding[]
  index: IndexAdvice | null
}

const DOCS = 'https://www.mongodb.com/docs/manual'
export const LINKS = {
  explain: `${DOCS}/reference/explain-results/`,
  analyze: `${DOCS}/tutorial/analyze-query-plan/`,
  sort: `${DOCS}/tutorial/sort-results-with-indexes/`,
  esr: `${DOCS}/tutorial/equality-sort-range-guideline/`,
  covered: `${DOCS}/core/query-optimization/#covered-query`,
  multikey: `${DOCS}/core/indexes/index-types/index-multikey/multikey-index-bounds/`,
  lookup: `${DOCS}/reference/operator/aggregation/lookup/`,
  sharding: `${DOCS}/core/sharded-cluster-query-router/`,
  plans: `${DOCS}/core/query-plans/`,
  cbr: 'https://www.mongodb.com/docs/v8.3/reference/explain-results/',
  in: `${DOCS}/reference/operator/query/in/`,
  aggSort: `${DOCS}/reference/operator/aggregation/sort/`,
  group: `${DOCS}/reference/operator/aggregation/group/`,
  shell: 'https://www.mongodb.com/docs/mongodb-shell/reference/configure-shell-settings/',
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && !Number.isNaN(v) ? v : typeof v === 'boolean' ? +v : undefined)
const sum = (xs: (number | undefined)[]) => (xs.some((x) => x !== undefined) ? xs.reduce<number>((a, b) => a + (b ?? 0), 0) : undefined)
const SPILL_KEYS = ['usedDisk', 'spills', 'spilledBytes', 'spilledRecords', 'spilledDataStorageSize', 'peakTrackedMemBytes', 'memLimit']

/** Child stages of a plan/execution node. Shard entries are returned as their winningPlan / executionStages. */
function children(n: Obj | undefined): [string, Obj, boolean][] {
  if (!isObj(n)) return []
  const root: Obj = isObj(n.queryPlan) ? n.queryPlan : n
  const out: [string, Obj, boolean][] = []
  if (isObj(root.inputStage)) out.push(['', root.inputStage, false])
  for (const s of Array.isArray(root.inputStages) ? root.inputStages : []) out.push(['', s, false])
  for (const k of ['outerStage', 'innerStage', 'thenStage', 'elseStage']) if (isObj(root[k])) out.push([k.slice(0, -5), root[k], false])
  for (const s of Array.isArray(root.shards) ? root.shards : []) {
    if (isObj(s)) out.push([String(s.shardName ?? 'shard'), s.executionStages ?? s.winningPlan ?? s, true])
  }
  return out
}

function mk(d: Obj, kids: PlanNode[], id: string, label?: string): PlanNode {
  return {
    id, label, d, children: kids,
    stage: String(d.stage ?? '?'),
    nReturned: num(d.nReturned),
    ms: num(d.executionTimeMillisEstimate ?? d.executionTimeMillis),
    keys: num(d.keysExamined ?? d.totalKeysExamined),
    docs: num(d.docsExamined ?? d.totalDocsExamined),
    works: num(d.works),
    cost: num(d.costEstimate),
    card: num(d.cardinalityEstimate),
    ceSource: d.estimatesMetadata?.ceSource,
    heat: 0,
  }
}

/** SBE execution stats keyed by planNodeId: the top-most SBE stage gives nReturned/time; scans give keys/docs. */
function sbeStats(exec: Obj | undefined) {
  const m = new Map<number, Obj>()
  const walk = (n: Obj) => {
    const id = n.planNodeId
    if (id !== undefined) {
      let s = m.get(id)
      if (!s) m.set(id, (s = { nReturned: n.nReturned, executionTimeMillisEstimate: n.executionTimeMillisEstimate }))
      const reads = num(n.keysExamined ?? n.numReads) ?? 0
      if (/ix/i.test(n.stage)) s.keysExamined = (s.keysExamined ?? 0) + reads
      else if (n.stage === 'scan' || n.stage === 'seek') s.docsExamined = (s.docsExamined ?? 0) + (num(n.numReads) ?? 0)
      for (const k of SPILL_KEYS) if (k in n && !(k in s)) s[k] = n[k]
    }
    for (const [, c] of children(n)) walk(c)
  }
  if (isObj(exec)) walk(exec)
  return m
}

function buildSbe(p: Obj, stats: Map<number, Obj>, id: string, label?: string): PlanNode {
  const kids = children(p).map(([l, c], i) => buildSbe(c, stats, `${id}.${i}`, l || undefined))
  return mk({ ...p, ...stats.get(p.planNodeId) }, kids, id, label)
}

function buildClassic(p: Obj | undefined, e: Obj | undefined, id: string, label?: string): PlanNode {
  const pk = children(p), ek = children(e)
  const kids = Array.from({ length: Math.max(pk.length, ek.length) }, (_, i) => {
    const [l, , shard] = ek[i] ?? pk[i]
    const cid = `${id}.${i}`
    return shard ? buildPlan(pk[i]?.[1], ek[i]?.[1], cid, l) : buildClassic(pk[i]?.[1], ek[i]?.[1], cid, l || undefined)
  }).filter((x): x is PlanNode => !!x)
  return mk({ ...p, ...e }, kids, id, label)
}

/** Build the winning plan tree, merging queryPlanner estimates with executionStats actuals. */
export function buildPlan(winningPlan: Obj | undefined, exec: Obj | undefined, id = 'r', label?: string): PlanNode | null {
  if (isObj(winningPlan?.queryPlan)) return buildSbe(winningPlan.queryPlan, sbeStats(exec), id, label)
  if (!isObj(winningPlan) && !isObj(exec)) return null
  if (exec && !winningPlan && /^[a-z]/.test(String(exec.stage))) return null // bare SBE tree without plan
  return buildClassic(winningPlan, exec, id, label)
}

export function walk(n: PlanNode | null, fn: (n: PlanNode, parent?: PlanNode) => void, parent?: PlanNode) {
  if (!n) return
  fn(n, parent)
  for (const c of n.children) walk(c, fn, n)
}

function heat(tree: PlanNode | null) {
  if (!tree) return
  let hasTime = false
  walk(tree, (n) => {
    n.selfMs = n.ms === undefined ? undefined : Math.max(0, n.ms - (sum(n.children.map((c) => c.ms)) ?? 0))
    if ((n.ms ?? 0) > 0) hasTime = true
  })
  const metric = (n: PlanNode) => (hasTime ? n.selfMs ?? 0 : (n.docs ?? 0) + (n.keys ?? 0))
  let max = 0
  walk(tree, (n) => { max = Math.max(max, metric(n)) })
  walk(tree, (n) => { n.heat = max > 0 ? metric(n) / max : 0 })
}

function indexNames(n: unknown, out = new Set<string>()): string[] {
  if (Array.isArray(n)) n.forEach((x) => indexNames(x, out))
  else if (isObj(n)) {
    for (const [k, v] of Object.entries(n)) {
      if (k === 'slotBasedPlan' || k === 'indexesUsed') continue
      if (k === 'indexName' && typeof v === 'string') out.add(v)
      else if (typeof v === 'object') indexNames(v, out)
    }
  }
  return [...out]
}

function hasStage(n: Obj | undefined, re: RegExp): boolean {
  if (!isObj(n)) return false
  const root = n.queryPlan ?? n
  return re.test(String(root.stage)) || children(root).some(([, c]) => hasStage(c, re))
}

export function describe(n: Obj): string {
  n = n.queryPlan ?? n
  const ks = children(n).map(([, c]) => describe(c))
  const me = /IXSCAN$/.test(n.stage) && n.indexName ? `${n.stage} ${n.indexName}` : String(n.stage)
  return ks.length === 0 ? me : ks.length === 1 ? `${ks[0]} → ${me}` : `${me}(${ks.join(', ')})`
}

const sig = (n: unknown) => indexNames(n).sort().join('|') || 'COLLSCAN'

function planRows(qp: Obj, allPlans: Obj[] | undefined, prefix = ''): PlanRow[] {
  const plans = [qp.winningPlan, ...(Array.isArray(qp.rejectedPlans) ? qp.rejectedPlans : [])].filter(isObj)
  const rows: PlanRow[] = plans.map((p, i) => {
    const root = p.queryPlan ?? p
    return {
      name: prefix + (i ? `Rejected #${i}` : 'Winning plan'),
      winner: i === 0,
      shape: describe(p),
      indexes: indexNames(root),
      sort: hasStage(root, /^SORT$/),
      fetch: hasStage(root, /^FETCH$/),
      cached: typeof p.isCached === 'boolean' ? p.isCached : undefined,
      cost: num(root.costEstimate ?? p.costEstimate),
      card: num(root.cardinalityEstimate ?? p.cardinalityEstimate),
    }
  })
  const used = new Set<number>()
  for (const ap of allPlans ?? []) {
    const s = sig(ap.executionStages)
    const i = rows.findIndex((r, j) => !used.has(j) && (r.indexes.slice().sort().join('|') || 'COLLSCAN') === s)
    if (i < 0) continue
    used.add(i)
    const ex = ap.executionStages ?? {}
    Object.assign(rows[i], {
      nReturned: num(ap.nReturned), keys: num(ap.totalKeysExamined), docs: num(ap.totalDocsExamined),
      ms: num(ap.executionTimeMillisEstimate), works: num(ex.works), advanced: num(ex.advanced) ?? num(ap.nReturned),
      score: num(ap.score), eof: ex.isEOF === undefined ? undefined : !!ex.isEOF,
    })
  }
  return rows
}

function explainWhy(rows: PlanRow[]): string[] {
  const [w, ...rej] = rows
  if (!w) return []
  if (!rej.length) return ['Only one candidate plan was generated, so the planner had nothing to compare.']
  const out: string[] = []
  const costed = rej.filter((r) => r.cost !== undefined)
  if (w.cost !== undefined && costed.length) {
    const best = costed.reduce((a, b) => (b.cost! < a.cost! ? b : a))
    out.push(`The cost-based ranker picked the plan with the lowest costEstimate: ${fmt(w.cost)} vs ${fmt(best.cost)} for the cheapest alternative (${(best.cost! / Math.max(w.cost, 1e-9)).toFixed(1)}× more expensive). Costs come from cardinality estimates, so a misestimate can make the wrong plan look cheap.`)
  } else if (rows.some((r) => r.works !== undefined || r.nReturned !== undefined)) {
    const prod = (r: PlanRow) => (r.works ? (r.advanced ?? 0) / r.works : 0)
    if (rows.every((r) => !(r.advanced ?? r.nReturned))) {
      out.push('No candidate returned a single document during the trial period (each one needs a blocking SORT, or nothing matched yet), so every productivity score tied at zero and tie-breakers decided. The choice is close to arbitrary; an index that provides the sort order removes the tie.')
    } else {
      const best = rej.reduce((a, b) => (prod(b) > prod(a) ? b : a))
      out.push(`During the trial the winner returned ${fmt(w.advanced)} documents in ${fmt(w.works ?? w.keys)} ${w.works ? 'work units' : 'keys'} (productivity ${prod(w).toFixed(3)}), versus ${fmt(best.advanced)} in ${fmt(best.works ?? best.keys)} for the best rejected plan (${prod(best).toFixed(3)}). The multi-planner keeps the most productive plan.`)
      if (w.eof) out.push('The winner reached end-of-stream during the trial, which ends plan selection immediately.')
    }
    if (w.score !== undefined) out.push(`Reported multi-planner score for the winner: ${fmt(w.score)}.`)
  } else {
    out.push('No trial statistics are present. Re-run with explain("allPlansExecution") to see the numbers that decided between candidates.')
  }
  if (!w.sort && rej.some((r) => r.sort)) out.push('The winner avoids a blocking SORT by reading the index in order (it earns the noSortBonus tie-breaker).')
  if (!w.fetch && rej.some((r) => r.fetch)) out.push('The winner is covered by its index and never fetches documents (noFetchBonus).')
  return out
}

function makePart(e: Obj, label: string): QueryPart {
  const qp = isObj(e.queryPlanner) ? e.queryPlanner : {}
  const es = isObj(e.executionStats) ? e.executionStats : undefined
  const wp = qp.winningPlan
  const tree = buildPlan(wp, es?.executionStages)
  heat(tree)
  let plans: PlanRow[]
  if (Array.isArray(wp?.shards)) {
    plans = wp.shards.flatMap((s: Obj) => {
      const ap = Array.isArray(es?.allPlansExecution) ? es.allPlansExecution.find((x: Obj) => x.shardName === s.shardName)?.allPlans : undefined
      return planRows(s, ap, `${s.shardName}: `)
    })
  } else plans = planRows(qp, es?.allPlansExecution)
  const sbe = !!wp?.queryPlan || (Array.isArray(wp?.shards) && wp.shards.some((s: Obj) => s.winningPlan?.queryPlan)) || e.explainVersion === '2'
  return {
    label,
    namespace: qp.namespace,
    engine: sbe ? 'sbe' : 'classic',
    tree,
    plans,
    why: Array.isArray(wp?.shards) ? [] : explainWhy(plans),
    parsedQuery: qp.parsedQuery ?? wp?.shards?.[0]?.parsedQuery,
    nReturned: num(es?.nReturned), keys: num(es?.totalKeysExamined), docs: num(es?.totalDocsExamined), ms: num(es?.executionTimeMillis),
  }
}

function collect(e: Obj, parts: QueryPart[], pipeline: PipeStage[], shard?: string) {
  const pre = shard ? `${shard} · ` : ''
  if (Array.isArray(e.stages)) {
    for (const s of e.stages) {
      if (!isObj(s)) continue
      const name = Object.keys(s).find((k) => k.startsWith('$')) ?? '?'
      if (name === '$cursor') parts.push(makePart({ ...s.$cursor, explainVersion: e.explainVersion }, `${pre}$cursor`))
      pipeline.push({ name, spec: s[name], d: s, nReturned: num(s.nReturned), ms: num(s.executionTimeMillisEstimate), shard })
    }
    if (isObj(e.queryPlanner) && !e.stages.some((s: Obj) => s?.$cursor)) parts.push(makePart(e, `${pre}Query`))
  } else if (isObj(e.queryPlanner)) parts.push(makePart(e, `${pre}Query`))
  if (isObj(e.shards) && !Array.isArray(e.shards)) for (const [name, sub] of Object.entries(e.shards)) if (isObj(sub)) collect(sub, parts, pipeline, name)
  for (const s of e.splitPipeline?.mergerPart ?? []) {
    const name = Object.keys(s)[0]
    pipeline.push({ name, spec: s[name], d: s, shard: 'merger' })
  }
}

function hasKey(v: unknown, key: string): boolean {
  if (Array.isArray(v)) return v.some((x) => hasKey(x, key))
  return isObj(v) && Object.entries(v).some(([k, x]) => k === key || hasKey(x, key))
}

// ---------- query shape: filter / sort / projection ----------

function queryShape(root: Obj, parts: QueryPart[]) {
  const cmd = isObj(root.command) ? root.command : {}
  let filter: Obj | undefined = isObj(cmd.filter) ? cmd.filter : isObj(cmd.query) ? cmd.query : undefined
  let sort: Obj | undefined = isObj(cmd.sort) ? cmd.sort : undefined
  if (Array.isArray(cmd.pipeline)) {
    const lead: Obj[] = []
    for (const st of cmd.pipeline) {
      if (isObj(st?.$match)) lead.push(st.$match)
      else if (isObj(st?.$sort) && !sort) { sort = st.$sort; break }
      else break
    }
    if (lead.length && !filter) filter = lead.length === 1 ? lead[0] : { $and: lead }
  }
  filter ??= parts[0]?.parsedQuery
  if (!sort) walk(parts[0]?.tree ?? null, (n) => { if (!sort && n.stage === 'SORT' && isObj(n.d.sortPattern)) sort = n.d.sortPattern })
  const projection = isObj(cmd.projection) ? cmd.projection : isObj(cmd.fields) ? cmd.fields : undefined
  let coll = typeof cmd.find === 'string' ? cmd.find : typeof cmd.aggregate === 'string' ? cmd.aggregate : undefined
  const ns = parts[0]?.namespace ?? (coll && cmd.$db ? `${cmd.$db}.${coll}` : undefined)
  coll ??= ns?.slice(ns.indexOf('.') + 1)
  return { filter, sort, projection, coll, ns }
}

const RANGE_OPS = new Set(['$gt', '$gte', '$lt', '$lte', '$ne', '$nin', '$exists', '$type', '$regex', '$not', '$size', '$mod', '$all', '$geoWithin', '$near', '$nearSphere', '$geoIntersects'])

/** Classify each filter field as Equality or Range for the ESR guideline. */
export function classify(filter: Obj | undefined, notes: string[] = []) {
  const out = new Map<string, 'E' | 'R'>()
  const visit = (f: Obj) => {
    for (const [k, v] of Object.entries(f)) {
      if (k === '$and' && Array.isArray(v)) v.filter(isObj).forEach(visit)
      else if (k === '$or' || k === '$nor') notes.push(`The filter uses ${k}; each branch is planned separately and needs its own index (OR stage).`)
      else if (k.startsWith('$')) notes.push(`${k} can't use regular index bounds and is ignored here.`)
      else {
        let kind: 'E' | 'R' = 'E'
        const ops = isObj(v) ? Object.keys(v).filter((o) => o.startsWith('$')) : []
        if (ops.some((o) => RANGE_OPS.has(o))) kind = 'R'
        if (isObj(v) && '$regex' in v && !String(v.$regex).startsWith('^')) notes.push(`Unanchored regex on "${k}" scans the whole index range; anchor it with ^ if possible.`)
        if (isObj(v) && Array.isArray(v.$in) && v.$in.length > 1) notes.push(`$in on "${k}" counts as equality; with a sort, MongoDB merges one sorted run per value (up to 200 values) before treating it as a range.`)
        if (ops.includes('$ne') || ops.includes('$nin')) notes.push(`Negation on "${k}" ($ne/$nin) is range-like and rarely selective.`)
        if (out.get(k) !== 'E') out.set(k, kind)
      }
    }
  }
  if (isObj(filter)) visit(filter)
  return out
}

const keyStr = (keys: [string, number][]) => show(Object.fromEntries(keys))

export function suggestIndex(filter: Obj | undefined, sort: Obj | undefined, projection: Obj | undefined, coll = 'collection', current?: Obj): IndexAdvice | null {
  const notes: string[] = []
  const fields = classify(filter, notes)
  const eq = [...fields].filter(([, k]) => k === 'E').map(([f]) => f)
  const sortKeys = Object.entries(isObj(sort) ? sort : {}).filter(([f, d]) => !eq.includes(f) && typeof d === 'number') as [string, number][]
  const range = [...fields].filter(([f, k]) => k === 'R' && !sortKeys.some(([s]) => s === f)).map(([f]) => f)
  const keys: [string, number][] = [...eq.map((f): [string, number] => [f, 1]), ...sortKeys.map(([f, d]): [string, number] => [f, d < 0 ? -1 : 1]), ...range.map((f): [string, number] => [f, 1])]
  if (!keys.length) return null
  if (eq.length > 1) notes.unshift('Equality fields can go in any order; put fields that other queries also filter on first so the index is reusable.')
  if (range.length > 1) notes.push(`Only the first range field ("${range[0]}") gets tight bounds; later range fields are filtered from index keys.`)
  // Covering: append projected fields when the projection is a small inclusion that excludes _id.
  if (isObj(projection)) {
    const incl = Object.entries(projection).filter(([f, v]) => f !== '_id' && (v === 1 || v === true)).map(([f]) => f)
    const extra = incl.filter((f) => !keys.some(([k]) => k === f))
    const excludesId = projection._id === 0 || projection._id === false
    if (incl.length && extra.length <= 4 && Object.values(projection).every((v) => typeof v !== 'object')) {
      if (excludesId) keys.push(...extra.map((f): [string, number] => [f, 1]))
      if (extra.length && excludesId) notes.push(`Appended projected field(s) ${extra.join(', ')} so the query can be covered by the index.`)
      if (!excludesId) notes.push('Add _id: 0 to the projection (and the projected fields to the index) to make this a covered query.')
    }
  }
  const cur = isObj(current) ? Object.keys(current) : undefined
  const matchesCurrent = !!cur && keys.every(([f], i) => cur[i] === f)
  const safe = /^[A-Za-z_][\w]*$/.test(coll)
  return {
    keys, eq, sort: sortKeys.map(([f]) => f), range, notes,
    command: `db.${safe ? coll : `getCollection('${coll}')`}.createIndex(${keyStr(keys)})`,
    current: cur ? show(current) : undefined,
    matchesCurrent,
  }
}

// ---------- findings ----------

const ratioSev = (r: number): Severity | null => (r >= 100 ? 'bad' : r >= 10 ? 'warn' : null)
const SEV_ORDER: Record<Severity, number> = { bad: 0, warn: 1, info: 2, good: 3 }

function fieldsOf(filter: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(filter)) filter.forEach((f) => fieldsOf(f, out))
  else if (isObj(filter)) for (const [k, v] of Object.entries(filter)) k.startsWith('$') ? fieldsOf(v, out) : out.add(k)
  return out
}

function bigIns(filter: unknown, out: [string, number][] = [], field = ''): [string, number][] {
  if (Array.isArray(filter)) filter.forEach((f) => bigIns(f, out, field))
  else if (isObj(filter)) for (const [k, v] of Object.entries(filter)) {
    if ((k === '$in' || k === '$nin') && Array.isArray(v) && v.length > 200) out.push([field, v.length])
    else bigIns(v, out, k.startsWith('$') ? field : k)
  }
  return out
}

function findings(a: Analysis, root: Obj, shape: ReturnType<typeof queryShape>, warnings: string[]): Finding[] {
  const f: Finding[] = []
  const add = (sev: Severity, title: string, detail: string, doc?: string, fix?: string) => f.push({ sev, title, detail, doc, fix })
  for (const w of warnings) add('warn', 'Shell output was truncated', w, LINKS.shell)
  if (a.verbosity === 'queryPlanner') add('info', 'No execution statistics', 'This explain ran in queryPlanner mode, so it only shows the chosen plan. Re-run with .explain("executionStats") (or "allPlansExecution" to see how candidates performed) to get documents examined, keys examined and timings.', LINKS.explain)

  for (const p of a.parts) {
    const at = a.parts.length > 1 ? ` (${p.label})` : ''
    let collscan = false
    const misest: PlanNode[] = []
    walk(p.tree, (n) => {
      const s = n.stage
      if (s === 'COLLSCAN') {
        collscan = true
        const small = n.docs !== undefined && n.docs < 1000
        add(small ? 'warn' : 'bad', `Collection scan${at}`, `COLLSCAN reads every document in ${p.namespace ?? 'the collection'}${n.docs !== undefined ? ` (${fmt(n.docs)} examined, ${fmt(n.nReturned)} returned)` : ''}${n.d.filter ? ` and applies the filter ${show(n.d.filter, 160)} to each one` : ''}. No index matched the predicate.${small ? ' The collection is small now, but this grows linearly with data.' : ''}`, LINKS.analyze)
      }
      if (s === 'SORT' || s === 'SORT_KEY_GENERATOR') {
        const disk = n.d.usedDisk === true || (num(n.d.spills) ?? 0) > 0
        if (s === 'SORT_KEY_GENERATOR') add('warn', `SORT_KEY_GENERATOR${at}`, 'Sort keys are being extracted from documents for a blocking in-memory sort (pre-4.4 plan shape). An index whose key order matches the sort removes both stages.', LINKS.sort)
        else add(disk ? 'bad' : 'warn', disk ? `In-memory sort spilled to disk${at}` : `Blocking in-memory SORT${at}`,
          `The plan sorts ${n.d.sortPattern ? show(n.d.sortPattern) : 'results'} in memory${n.d.limitAmount ? ` (top-${fmt(n.d.limitAmount)} sort)` : ''} instead of reading an index in order. It must consume all ${fmt(children0(n)?.nReturned)} input documents before returning the first one${n.d.memLimit ? `; the limit is ${mb(n.d.memLimit)} before it spills or fails` : ''}.${n.d.totalDataSizeSorted ? ` Data sorted: ${bytes(n.d.totalDataSizeSorted)}.` : ''}${disk ? ` It wrote to disk (${fmt(num(n.d.spills))} spills).` : ''}`, LINKS.sort)
      }
      if (s === 'FETCH' && n.d.filter && n.children.some((c) => /IXSCAN/.test(c.stage))) {
        const ix = n.children.find((c) => /IXSCAN/.test(c.stage))!
        const missing = [...fieldsOf(n.d.filter)].filter((x) => !(ix.d.keyPattern && x in ix.d.keyPattern))
        add('warn', `Index doesn't cover the whole predicate${at}`, `${ix.d.indexName ?? 'The index'} narrows the candidates, but FETCH still loads each document to check ${show(n.d.filter, 160)}${n.docs !== undefined ? `: ${fmt(n.docs)} fetched, ${fmt(n.nReturned)} kept` : ''}.${missing.length ? ` Adding ${missing.join(', ')} to the index would filter on keys instead.` : ''}`, LINKS.esr)
      }
      if (/IXSCAN$/.test(s) && n.d.isMultiKey === true) {
        const paths = isObj(n.d.multiKeyPaths) ? Object.entries(n.d.multiKeyPaths).filter(([, v]) => Array.isArray(v) && v.length).map(([k]) => k) : []
        add('info', `Multikey index ${n.d.indexName ?? ''}${at}`.trim(), `The index has array values${paths.length ? ` on ${paths.join(', ')}` : ''}. Each document can produce many keys (dupsTested: ${fmt(num(n.d.dupsTested))}), bounds on multikey fields can't always be compounded, and queries on those fields can't be covered.`, LINKS.multikey)
      }
      if (s === 'SHARD_MERGE' && n.children.length > 1) add('warn', `Scatter-gather across ${n.children.length} shards`, `mongos sent this query to ${n.children.length} shards (${n.children.map((c) => c.label).join(', ')}) and merged the results. Include the shard key (ideally an equality on it) in the filter so the query targets a single shard.`, LINKS.sharding)
      if (s === 'SINGLE_SHARD') add('good', 'Targeted a single shard', 'mongos routed the query to one shard using the shard key.', LINKS.sharding)
      if (s === 'EQ_LOOKUP') {
        const strat = String(n.d.strategy ?? '')
        const what = `$lookup into ${n.d.foreignCollection ?? 'the foreign collection'} on ${n.d.foreignField ?? '?'}`
        if (strat === 'NestedLoopJoin') add('bad', `${what} has no index`, 'The SBE nested-loop join scans the foreign collection once per local document.', LINKS.lookup, `db.${String(n.d.foreignCollection ?? 'foreign').split('.').pop()}.createIndex({ ${n.d.foreignField}: 1 })`)
        else if (strat === 'HashJoin') add('warn', `${what} uses a hash join`, 'No usable index on the foreign field, so SBE builds an in-memory hash table of the whole foreign collection. Fine for small collections; index the foreign field for large ones.', LINKS.lookup)
        else if (strat) add('good', `${what} uses ${n.d.indexName ?? 'an index'}`, `Join strategy: ${strat}.`, LINKS.lookup)
      }
      if (s === 'GROUP' && (n.d.usedDisk === true || (num(n.d.spills) ?? 0) > 0)) add('warn', `GROUP spilled to disk${at}`, `The group stage exceeded its memory limit and spilled ${fmt(num(n.d.spills))} times.`, LINKS.group)
      if (s === 'AND_SORTED' || s === 'AND_HASH') add('info', `Index intersection (${s})${at}`, 'Two indexes are being intersected. A single compound index on the same fields is almost always faster.', LINKS.esr)
      if (s === 'IDHACK' || s.startsWith('EXPRESS')) add('good', `Fast path: ${s}${at}`, 'The query bypassed regular planning and used an optimized point lookup.', LINKS.explain)
      if (s === 'EOF' && n.d.type === 'nonExistentNamespace') add('warn', 'Namespace does not exist', 'The collection was not found, so the plan is empty. Check the database and collection names.', LINKS.explain)
      if (n.card !== undefined && n.nReturned !== undefined) {
        const hi = Math.max(n.card, n.nReturned), lo = Math.max(Math.min(n.card, n.nReturned), 1)
        if (hi / lo >= 3 && hi >= 50) misest.push(n)
      }
    })
    if (misest.length) {
      const r = (n: PlanNode) => Math.max(n.card!, n.nReturned!) / Math.max(Math.min(n.card!, n.nReturned!), 1)
      misest.sort((x, y) => r(y) - r(x))
      const worst = r(misest[0])
      const cheaper = p.plans.filter((x) => !x.winner && x.cost !== undefined)
      add(worst >= 10 ? 'bad' : 'warn', `Cardinality misestimate (${worst.toFixed(1)}×)${at}`,
        misest.map((n) => `${n.stage}${n.d.indexName ? ` ${n.d.indexName}` : ''}: estimated ${fmt(Math.round(n.card!))} (${n.ceSource ?? 'unknown source'}), actual ${fmt(n.nReturned)} (${n.card! < n.nReturned! ? 'under' : 'over'}-estimated ${r(n).toFixed(1)}×)`).join('; ') +
        `. The cost-based ranker ranks plans from these estimates${cheaper.length ? `, so the ${cheaper.length} rejected plan(s) may actually be cheaper` : ''}. Stale samples or skewed values are common causes; compare with explain("allPlansExecution") or pin a plan with setQuerySettings.`, LINKS.cbr)
    }
    if (p.nReturned !== undefined) {
      const ret = Math.max(p.nReturned, 1)
      const kr = (p.keys ?? 0) / ret, dr = (p.docs ?? 0) / ret
      const ks = (p.keys ?? 0) >= 1000 ? ratioSev(kr) : null
      if (ks) add(ks, `Keys examined ≫ returned${at}`, `${fmt(p.keys)} index keys examined to return ${fmt(p.nReturned)} documents (${fmt(Math.round(kr))}:1). The index bounds are much wider than the result, typically because a range field precedes an equality or sort field in the index.`, LINKS.esr)
      const ds = !collscan && (p.docs ?? 0) >= 1000 ? ratioSev(dr) : null
      if (ds) add(ds, `Documents examined ≫ returned${at}`, `${fmt(p.docs)} documents loaded to return ${fmt(p.nReturned)} (${fmt(Math.round(dr))}:1). Work is being thrown away after FETCH or a blocking sort with a limit.`, LINKS.analyze)
    }
    let covered = false
    walk(p.tree, (n) => { if (n.stage === 'PROJECTION_COVERED') covered = true })
    if (!covered && p.docs === 0 && (p.keys ?? 0) > 0 && !hasNode(p.tree, /FETCH|COLLSCAN/)) covered = true
    if (covered) add('good', `Covered query${at}`, `Answered from index keys alone: ${fmt(p.keys)} keys, 0 documents fetched.`, LINKS.covered)
    else if (shape.projection && p.tree) {
      walk(p.tree, (n) => {
        const ix = n.children[0]
        if (n.stage !== 'FETCH' || n.d.filter || n.children.length !== 1 || !/IXSCAN/.test(ix.stage) || !isObj(ix.d.keyPattern)) return
        const proj = Object.entries(shape.projection!).filter(([k, v]) => k !== '_id' && (v === 1 || v === true)).map(([k]) => k)
        if (!proj.length || ix.d.isMultiKey) return
        const inIndex = proj.every((k) => k in ix.d.keyPattern)
        const idOk = shape.projection!._id === 0 || shape.projection!._id === false || '_id' in ix.d.keyPattern
        if (inIndex && !idOk) add('warn', 'Could be a covered query', `Every projected field is in ${ix.d.indexName}, but _id is returned by default and isn't in the index, so each document is fetched. Add _id: 0 to the projection to skip FETCH entirely.`, LINKS.covered)
        else if (!inIndex) add('info', 'Not a covered query', `The projection needs ${proj.filter((k) => !(k in ix.d.keyPattern)).join(', ')}, which ${ix.d.indexName} doesn't contain, so documents are fetched. If this query is hot, extend the index (and exclude _id) to cover it.`, LINKS.covered)
      })
    }
    if (root.queryPlanner?.maxScansToExplodeReached || p.tree?.d?.maxScansToExplodeReached) add('warn', 'maxScansToExplodeReached', 'The planner hit the limit (200) on exploding $in / OR bounds into sorted index scans, so it fell back to a blocking sort.', LINKS.in)
  }

  for (const [field, n] of bigIns(shape.filter)) add('warn', `Large $in on ${field || 'a field'} (${fmt(n)} values)`, 'Very large $in lists inflate the plan, the index bounds and the query shape. Past 200 values MongoDB stops merging sorted runs for a sort. Consider a join collection, a range, or batching.', LINKS.in)

  for (const st of a.pipeline) {
    const d = st.d, s = isObj(st.spec) ? st.spec : {}
    const disk = d.usedDisk === true || (num(d.spills) ?? 0) > 0
    const where = st.shard ? ` (${st.shard})` : ''
    if (st.name === '$lookup') {
      const scans = num(d.collectionScans) ?? 0
      const used = Array.isArray(d.indexesUsed) ? d.indexesUsed : []
      const target = `$lookup from "${s.from}"${s.foreignField ? ` on ${s.foreignField}` : ''}`
      if (scans > 0 || (!used.length && (num(d.totalDocsExamined) ?? 0) > 0)) {
        add('bad', `${target} scans the foreign collection${where}`, `${fmt(scans)} collection scans and ${fmt(num(d.totalDocsExamined))} documents examined on the inner side (${fmt(st.ms)} ms). Every local document triggers a full scan of "${s.from}". Index the foreign field.`, LINKS.lookup, s.foreignField ? `db.${s.from}.createIndex({ ${/^[A-Za-z_]\w*$/.test(s.foreignField) ? s.foreignField : `'${s.foreignField}'`}: 1 })` : undefined)
      } else if (used.length) add('good', `${target} uses ${used.join(', ')}${where}`, `${fmt(num(d.totalKeysExamined))} keys and ${fmt(num(d.totalDocsExamined))} documents examined on the inner side.`, LINKS.lookup)
    }
    if (st.name === '$sort' && disk) add('bad', `$sort spilled to disk${where}`, `The pipeline sort exceeded 100 MB and wrote ${bytes(d.spilledDataStorageSize ?? d.spilledBytes)} to disk across ${fmt(num(d.spills))} spills. Sort earlier with an index or reduce documents first.`, LINKS.aggSort)
    else if (st.name === '$sort') add('info', `In-memory $sort of ${fmt(st.nReturned)} documents${where}`, `This $sort runs in the aggregation layer, not from an index${d.totalDataSizeSortedBytesEstimate ? ` (${bytes(d.totalDataSizeSortedBytesEstimate)})` : ''}. That is expected after $group; before $group it means no index provided the order.`, LINKS.aggSort)
    if (st.name === '$group' && disk) add('warn', `$group spilled to disk${where}`, `$group exceeded its memory limit and spilled ${fmt(num(d.spills))} times (${bytes(d.spilledDataStorageSize ?? d.spilledBytes)} on disk).`, LINKS.group)
  }
  const shardNames = isObj(root.shards) && !Array.isArray(root.shards) ? Object.keys(root.shards) : []
  if (shardNames.length > 1) add('warn', `Aggregation ran on ${shardNames.length} shards`, `The shards part of the pipeline ran on ${shardNames.join(', ')} and was merged${root.mergeType ? ` on ${root.mergeType}` : ''}. Start the pipeline with a $match on the shard key to target fewer shards.`, LINKS.sharding)

  if (!f.some((x) => x.sev === 'bad' || x.sev === 'warn')) add('good', 'No obvious problems', 'The plan uses indexes and examines roughly what it returns.', LINKS.analyze)
  return f.sort((x, y) => SEV_ORDER[x.sev] - SEV_ORDER[y.sev])
}

const children0 = (n: PlanNode) => n.children[0]
const hasNode = (t: PlanNode | null, re: RegExp) => { let hit = false; walk(t, (n) => { if (re.test(n.stage)) hit = true }); return hit }
const mb = (b: number) => `${fmt(Math.round(b / 1048576))} MB`
export const bytes = (b: unknown) => {
  const n = num(b)
  if (n === undefined) return '—'
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
}

// ---------- entry point ----------

export function analyze(root: unknown, warnings: string[] = []): Analysis {
  if (Array.isArray(root) && root.length === 1) root = root[0]
  if (!isObj(root) || !(isObj(root.queryPlanner) || Array.isArray(root.stages) || isObj(root.shards))) {
    throw new Error('This does not look like explain() output: expected a document with "queryPlanner", "stages" (aggregation) or "shards" (sharded aggregation).')
  }
  const parts: QueryPart[] = []
  const pipeline: PipeStage[] = []
  collect(root, parts, pipeline)
  const shape = queryShape(root, parts)
  const verbosity = hasKey(root, 'allPlansExecution') ? 'allPlansExecution' : hasKey(root, 'executionStats') || pipeline.some((s) => s.nReturned !== undefined) ? 'executionStats' : 'queryPlanner'
  const lookups = pipeline.filter((s) => s.name === '$lookup')
  const qDocs = sum(parts.map((p) => p.docs)), qKeys = sum(parts.map((p) => p.keys)), qRet = sum(parts.map((p) => p.nReturned))
  const top = isObj(root.executionStats) ? root.executionStats : undefined
  const last = [...pipeline].reverse().find((s) => s.nReturned !== undefined)
  const nReturned = last?.nReturned ?? num(top?.nReturned) ?? qRet
  const docs = sum([qDocs, ...lookups.map((s) => num(s.d.totalDocsExamined))])
  const keys = sum([qKeys, ...lookups.map((s) => num(s.d.totalKeysExamined))])
  const ms = num(top?.executionTimeMillis) ?? (parts.length || last ? Math.max(...parts.map((p) => p.ms ?? 0), last?.ms ?? 0) : undefined)
  const ratio = qDocs !== undefined && qRet !== undefined ? qDocs / Math.max(qRet, 1) : undefined
  const health: Severity = ratio === undefined ? 'info' : ratio <= 2 ? 'good' : ratio <= 10 ? 'warn' : 'bad'
  let current: Obj | undefined
  walk(parts[0]?.tree ?? null, (n) => { if (!current && /IXSCAN$/.test(n.stage) && isObj(n.d.keyPattern)) current = n.d.keyPattern })
  const engines = [...new Set(parts.map((p) => p.engine))]
  const a: Analysis = {
    namespace: shape.ns,
    engine: engines.length ? engines.map((e) => (e === 'sbe' ? 'SBE (slot-based)' : 'Classic')).join(' + ') : 'Aggregation',
    verbosity,
    version: root.serverInfo?.version ?? (Object.values(isObj(root.shards) ? root.shards : {}) as Obj[])[0]?.serverInfo?.version ?? root.queryPlanner?.winningPlan?.shards?.[0]?.serverInfo?.version,
    aggregation: pipeline.length > 0 || isObj(root.command) && 'aggregate' in root.command,
    sharded: isObj(root.shards) || Array.isArray(root.queryPlanner?.winningPlan?.shards),
    nReturned, docs, keys, ms, ratio, health,
    parts, pipeline, findings: [],
    index: suggestIndex(shape.filter, shape.sort, shape.projection, shape.coll, current),
  }
  a.findings = findings(a, root, shape, warnings)
  return a
}
