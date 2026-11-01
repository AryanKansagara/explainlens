import { useDeferredValue, useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { Shell } from './Shell.tsx'
import { analyze, type Analysis, type Finding, type PlanNode, type PlanRow, type PipeStage, type QueryPart, type Severity } from './analyze.ts'
import { fmt, parseLenient, show, ParseError } from './parse.ts'
import { SAMPLES } from './samples.ts'
import { encode, decode } from './share.ts'

const HEALTH: Record<Severity, string> = {
  good: 'Healthy',
  warn: 'Needs attention',
  bad: 'Expensive',
  info: 'No exec stats',
}

type Result = { analysis: Analysis; warnings: string[] } | { error: string }

function run(text: string): Result | null {
  const t = text.trim()
  if (!t) return null
  try {
    const { value, warnings } = parseLenient(t)
    return { analysis: analyze(value, warnings), warnings }
  } catch (e) {
    return { error: e instanceof ParseError || e instanceof Error ? e.message : String(e) }
  }
}

export default function App() {
  const [paste, setPaste] = useState('')
  const [notice, setNotice] = useState('')
  const [partIdx, setPartIdx] = useState(0)
  const [over, setOver] = useState(false)
  const deferred = useDeferredValue(paste)

  useEffect(() => {
    const code = location.hash.replace(/^#/, '')
    if (!code) return
    decode(code).then(setPaste).catch(() => setNotice('That share link could not be decoded.'))
  }, [])

  const result = useMemo(() => run(deferred), [deferred])
  const analysis = result && 'analysis' in result ? result.analysis : null
  const error = result && 'error' in result ? result.error : null

  useEffect(() => { setPartIdx(0) }, [deferred])

  const flash = (s: string) => { setNotice(s); setTimeout(() => setNotice(''), 2500) }

  const share = async () => {
    if (!paste.trim()) return flash('Paste an explain() first.')
    try {
      const code = await encode(paste)
      history.replaceState(null, '', `#${code}`)
      await navigator.clipboard.writeText(location.href)
      flash('Share link copied to clipboard.')
    } catch {
      flash('Could not create a share link.')
    }
  }

  const loadFile = (f?: File | null) => { if (f) f.text().then(setPaste) }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); loadFile(e.dataTransfer.files[0]) }

  const part = analysis?.parts[Math.min(partIdx, Math.max(0, (analysis.parts.length || 1) - 1))] ?? null

  return (
    <Shell name="ExplainLens" tagline="MongoDB explain() plan visualizer" icon="account_tree">
      <section className="hero">
        <h1>See what MongoDB actually did</h1>
        <p>
          Paste <code>explain()</code> output — JSON, Extended JSON, or a mongosh paste — and ExplainLens
          turns it into a plan tree, findings, and index advice. Runs entirely in your browser.
        </p>
        <div className="privacy">
          <span className="badge good">Private</span>
          Runs entirely in your browser — explain output never leaves your machine.
        </div>
      </section>

      <section className="panel">
        <div className="head-row">
          <h2>Explain output</h2>
          <div className="row">
            <label className="btn ghost sm">
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>upload_file</span>
              Upload
              <input type="file" accept=".json,.txt,application/json,text/plain" hidden onChange={(e) => { loadFile(e.target.files?.[0]); e.target.value = '' }} />
            </label>
            {paste && <button type="button" className="btn ghost sm" onClick={() => setPaste('')}>Clear</button>}
            <button type="button" className="btn tonal sm" onClick={share} disabled={!paste.trim()}>
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>share</span>
              Share
            </button>
          </div>
        </div>

        <textarea
          className={over ? 'drag-over' : undefined}
          value={paste}
          spellCheck={false}
          aria-label="MongoDB explain output"
          placeholder={'Paste db.collection.find(...).explain("executionStats") output here.\n\nJSON, Extended JSON, and mongosh / legacy shell syntax are all accepted.'}
          onChange={(e) => setPaste(e.target.value)}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        />

        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Or try a sample</div>
          <div className="row">
            {SAMPLES.map((s) => (
              <button key={s.id} type="button" className="btn ghost sm" onClick={() => setPaste(s.text)}>{s.label}</button>
            ))}
          </div>
        </div>

        {notice && <p className="muted" style={{ marginTop: 10 }}>{notice}</p>}
        {error && <div className="finding bad" style={{ marginTop: 12 }}><strong>Parse error:</strong> {error}</div>}
        {result && 'warnings' in result && result.warnings.length > 0 && (
          <div className="finding warn" style={{ marginTop: 12 }}>
            <strong>Parse warnings:</strong> {result.warnings.join(' · ')}
          </div>
        )}
      </section>

      {analysis && (
        <>
          <Stats a={analysis} />
          <Findings findings={analysis.findings} />

          <div className="grid cols-2">
            <PlanPanel parts={analysis.parts} part={part} partIdx={partIdx} setPartIdx={setPartIdx} />
            {analysis.index && <IndexPanel advice={analysis.index} />}
          </div>

          {part && part.plans.length > 0 && <PlansTable plans={part.plans} why={part.why} />}
          {analysis.pipeline.length > 0 && <Pipeline stages={analysis.pipeline} />}
        </>
      )}

      {!analysis && !error && !paste.trim() && (
        <section className="panel muted" style={{ textAlign: 'center', padding: 32 }}>
          Paste an explain(), drop a file, or load a sample to get started.
        </section>
      )}
    </Shell>
  )
}

function Stats({ a }: { a: Analysis }) {
  const items: { label: string; value: ReactNode }[] = [
    { label: 'Health', value: <span className={`badge ${a.health}`}>{HEALTH[a.health]}</span> },
    { label: 'nReturned', value: fmt(a.nReturned) },
    { label: 'Docs examined', value: fmt(a.docs) },
    { label: 'Keys examined', value: fmt(a.keys) },
    { label: 'Time', value: a.ms !== undefined ? `${fmt(a.ms)} ms` : '—' },
    { label: 'Engine', value: a.engine },
    { label: 'Verbosity', value: a.verbosity },
    { label: 'Namespace', value: a.namespace ?? '—' },
  ]
  return (
    <section>
      <div className="head-row">
        <h2 style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          Overview
          {a.aggregation && <span className="badge info">aggregation</span>}
          {a.sharded && <span className="badge info">sharded</span>}
          {a.version && <span className="badge info">v{a.version}</span>}
          {a.ratio !== undefined && <span className={`badge ${a.health}`}>exam/ret {fmt(a.ratio)}×</span>}
        </h2>
      </div>
      <div className="stats">
        {items.map((it) => (
          <div key={it.label} className="stat">
            <div className="label">{it.label}</div>
            <div className="value" style={{ fontSize: typeof it.value === 'string' && it.value.length > 14 ? 18 : undefined }}>{it.value}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

function Findings({ findings }: { findings: Finding[] }) {
  if (!findings.length) return null
  return (
    <section className="panel">
      <h2>Findings</h2>
      {findings.map((f, i) => (
        <div key={i} className={`finding ${f.sev}`}>
          <div className="row spread">
            <strong>{f.title}</strong>
            <span className={`badge ${f.sev}`}>{f.sev}</span>
          </div>
          <p style={{ margin: '6px 0' }}>{f.detail}</p>
          <div className="row">
            {f.fix && <span className="muted" style={{ fontSize: 13 }}><strong>Fix:</strong> {f.fix}</span>}
            {f.doc && <a href={f.doc} target="_blank" rel="noreferrer">Docs</a>}
          </div>
        </div>
      ))}
    </section>
  )
}

function PlanPanel({ parts, part, partIdx, setPartIdx }: {
  parts: QueryPart[]; part: QueryPart | null; partIdx: number; setPartIdx: (i: number) => void
}) {
  if (!parts.length) {
    return (
      <section className="panel">
        <h2>Plan tree</h2>
        <p className="muted">No query planner stages in this explain (pipeline-only aggregation may still appear below).</p>
      </section>
    )
  }
  return (
    <section className="panel">
      <div className="head-row">
        <h2>Plan tree</h2>
        {part && (
          <span className="muted" style={{ fontSize: 13 }}>
            {part.engine === 'sbe' ? 'SBE' : 'Classic'}
            {part.namespace ? ` · ${part.namespace}` : ''}
          </span>
        )}
      </div>
      {parts.length > 1 && (
        <div className="tabs" role="tablist">
          {parts.map((p, i) => (
            <button key={p.label + i} type="button" role="tab" aria-selected={partIdx === i} onClick={() => setPartIdx(i)}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      {part?.parsedQuery && (
        <p className="mono muted" style={{ fontSize: 12.5, marginTop: 0 }}>filter: {show(part.parsedQuery, 280)}</p>
      )}
      {part?.tree ? <PlanTree node={part.tree} /> : <p className="muted">No winning plan tree for this part.</p>}
    </section>
  )
}

function PlanTree({ node }: { node: PlanNode }) {
  return (
    <ul className="tree">
      <TreeNode node={node} />
    </ul>
  )
}

function TreeNode({ node }: { node: PlanNode }) {
  const [open, setOpen] = useState(true)
  const hasKids = node.children.length > 0
  const hot = node.heat >= 0.55
  const bits: string[] = []
  if (node.nReturned !== undefined) bits.push(`n=${fmt(node.nReturned)}`)
  if (node.docs !== undefined) bits.push(`docs=${fmt(node.docs)}`)
  if (node.keys !== undefined) bits.push(`keys=${fmt(node.keys)}`)
  if (node.ms !== undefined) bits.push(`${fmt(node.ms)} ms`)
  if (node.selfMs !== undefined && node.children.length) bits.push(`self ${fmt(node.selfMs)} ms`)
  if (node.cost !== undefined) bits.push(`cost=${fmt(node.cost)}`)
  if (node.card !== undefined) bits.push(`card=${fmt(node.card)}`)
  if (node.works !== undefined) bits.push(`works=${fmt(node.works)}`)

  const detail = nodeDetail(node)

  return (
    <li>
      <div className={`node ${hot ? 'hot' : node.heat > 0.25 ? 'warm' : ''}`}>
        {hasKids ? (
          <button type="button" className="btn ghost sm" style={{ padding: '2px 8px', minWidth: 28 }} aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setOpen((o) => !o)}>
            {open ? '−' : '+'}
          </button>
        ) : <span style={{ width: 28 }} />}
        <span className="stage">{node.stage}</span>
        {node.label && <span className="badge info">{node.label}</span>}
        {detail && <span className="muted mono" style={{ fontSize: 12 }}>{detail}</span>}
        {bits.length > 0 && <span className="muted" style={{ fontSize: 12 }}>{bits.join(' · ')}</span>}
        {node.ceSource && <span className="badge info">{node.ceSource}</span>}
      </div>
      {hasKids && open && (
        <ul>
          {node.children.map((c) => <TreeNode key={c.id} node={c} />)}
        </ul>
      )}
    </li>
  )
}

function nodeDetail(n: PlanNode): string {
  const d = n.d
  if (typeof d.indexName === 'string') return d.indexName
  if (d.keyPattern) return show(d.keyPattern, 80)
  if (d.filter) return show(d.filter, 100)
  if (d.sortPattern) return `sort ${show(d.sortPattern, 60)}`
  if (d.transformBy) return show(d.transformBy, 80)
  return ''
}

function IndexPanel({ advice }: { advice: NonNullable<Analysis['index']> }) {
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard.writeText(advice.command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  return (
    <section className="panel">
      <div className="head-row">
        <h2>Index advice</h2>
        {advice.matchesCurrent
          ? <span className="badge good">Matches current</span>
          : advice.current ? <span className="badge warn">Different from current</span> : <span className="badge info">Suggested</span>}
      </div>
      <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
        ESR: equality [{advice.eq.join(', ') || '—'}] → sort [{advice.sort.join(', ') || '—'}] → range [{advice.range.join(', ') || '—'}]
      </p>
      {advice.current && <p className="mono muted" style={{ fontSize: 12.5 }}>Current index: {advice.current}</p>}
      <div className="code">
        <button type="button" className="btn ghost sm copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        <pre>{advice.command}</pre>
      </div>
      {advice.keys.length > 0 && (
        <p className="mono" style={{ fontSize: 13 }}>
          Keys: {advice.keys.map(([k, d]) => `${k}: ${d}`).join(', ')}
        </p>
      )}
      {advice.notes.length > 0 && (
        <ul className="advice">
          {advice.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </section>
  )
}

function PlansTable({ plans, why }: { plans: PlanRow[]; why: string[] }) {
  return (
    <section className="panel">
      <h2>Candidate plans</h2>
      {why.length > 0 && (
        <ul className="advice" style={{ marginBottom: 12 }}>
          {why.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Plan</th>
              <th>Shape</th>
              <th>Indexes</th>
              <th>Flags</th>
              <th>nReturned</th>
              <th>Keys</th>
              <th>Docs</th>
              <th>ms</th>
              <th>Cost</th>
              <th>Works</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.name}>
                <td>
                  {p.name}{' '}
                  {p.winner && <span className="badge good">winner</span>}
                  {p.cached && <span className="badge info">cached</span>}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>{p.shape}</td>
                <td className="mono" style={{ fontSize: 12 }}>{p.indexes.join(', ') || '—'}</td>
                <td>
                  {p.sort && <span className="badge warn">sort</span>}{' '}
                  {p.fetch && <span className="badge info">fetch</span>}
                  {p.eof === false && <span className="badge warn">!EOF</span>}
                </td>
                <td>{fmt(p.nReturned)}</td>
                <td>{fmt(p.keys)}</td>
                <td>{fmt(p.docs)}</td>
                <td>{fmt(p.ms)}</td>
                <td>{fmt(p.cost)}</td>
                <td>{fmt(p.works)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Pipeline({ stages }: { stages: PipeStage[] }) {
  return (
    <section className="panel">
      <h2>Aggregation pipeline</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Stage</th>
              <th>Spec</th>
              <th>nReturned</th>
              <th>ms</th>
              <th>Shard</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((s, i) => (
              <tr key={`${s.name}-${i}`}>
                <td>{i}</td>
                <td className="mono">{s.name}</td>
                <td className="mono" style={{ fontSize: 12 }}>{show(s.spec, 160)}</td>
                <td>{fmt(s.nReturned)}</td>
                <td>{fmt(s.ms)}</td>
                <td>{s.shard ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
