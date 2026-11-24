import { Shell } from './Shell.tsx'
import { BackToHome } from './router.tsx'
import { LINKS } from './analyze.ts'

export default function Docs() {
  return (
    <Shell name="ExplainLens" tagline="MongoDB explain() plan visualizer">
      <BackToHome />
      <section className="panel">
        <h2>What you can paste</h2>
        <ul className="advice">
          <li><strong>mongosh output</strong> of <code>.explain()</code>, <code>.explain("executionStats")</code> or <code>.explain("allPlansExecution")</code>: unquoted keys, single quotes, <code>Long('…')</code>, <code>ISODate(…)</code>, <code>ObjectId(…)</code>, long strings split as <code>'…' +</code> across lines, and the shell prompt around it.</li>
          <li><strong>Strict JSON or Extended JSON</strong> (Compass “Raw Output”, <code>EJSON.stringify</code>, driver output) including <code>$numberLong</code> / <code>$numberInt</code> wrappers.</li>
          <li><strong>Legacy shell</strong> syntax: <code>NumberLong(…)</code>, <code>NumberInt(…)</code>, <code>BinData(…)</code>.</li>
          <li><strong>Trimmed output</strong>: <code>... 120 more items</code>, <code>[Object]</code> from shallow <code>inspectDepth</code>, and hand-trimmed <code>...</code> lines as seen in docs and forum posts. These are flagged so you know the numbers may be partial.</li>
          <li>Plan shapes: classic and slot-based (SBE) engines, <code>find</code> and aggregation (<code>$cursor</code>, pushed-down <code>GROUP</code> / <code>EQ_LOOKUP</code>), sharded find (<code>SHARD_MERGE</code>) and sharded aggregation, and 8.x cost-based ranker estimates.</li>
        </ul>
      </section>
      <section className="panel">
        <h2>How the numbers are worked out</h2>
        <ul className="advice">
          <li><strong>Docs examined per doc returned</strong> = <code>totalDocsExamined / max(nReturned, 1)</code>. Up to 2 is healthy, up to 10 needs attention, above that is expensive. The ideal is 1:1, as in the MongoDB tutorial on analyzing query performance. The Health badge is never better than the worst finding: a warn finding caps it at needs attention and a bad finding at expensive.</li>
          <li><strong>Heat</strong> on the plan tree uses each stage's own time (its <code>executionTimeMillisEstimate</code> minus its children's); without timings it falls back to documents + keys examined.</li>
          <li><strong>Index advice</strong> follows the Equality, Sort, Range guideline. <code>$in</code> counts as equality; ranges after the first only filter keys. With a small inclusion projection that excludes <code>_id</code>, the projected fields are appended so the query can be covered.</li>
          <li>SBE stats are matched to plan stages by <code>planNodeId</code>; scan reads become documents examined.</li>
        </ul>
      </section>
      <section className="panel">
        <h2>Tested against real output</h2>
        <p>
          The parser and findings are tested against excerpts that follow the layout of the tested mongosh examples in the MongoDB manual
          (sample_mflix dataset on MongoDB 8.2.2): the COLLSCAN / indexed range query from the{' '}
          <a href="https://www.mongodb.com/docs/manual/tutorial/analyze-query-plan/">Analyze Query Performance</a> tutorial and the
          aggregation from <a href={LINKS.explain}>Explain Results</a> (source:{' '}
          <a href="https://github.com/mongodb/docs/tree/main/content/code-examples/tested/command-line/mongosh">mongodb/docs code-examples</a>, checked 2026-11-16).
          The built-in samples are synthetic and labelled as such.
        </p>
      </section>
      <section className="panel">
        <h2>Privacy and sharing</h2>
        <p>Nothing is uploaded. A share link stores the compressed paste in the URL fragment (after <code>#</code>), which browsers never send to the server. Anyone with the link can read the paste, so trim sensitive values from filters first.</p>
      </section>
    </Shell>
  )
}
