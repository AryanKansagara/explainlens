import { RouteApp } from './router.tsx'
import { Landing, MockFrame, MockStat, MockBars, MockList } from './Landing.tsx'
import Tool from './Tool.tsx'

function ProductLanding() {
  return (
    <Landing
      name="ExplainLens"
      icon="account_tree"
      tagline="MongoDB explain() plan visualizer"
      headline="See why MongoDB picked that plan"
      support="Paste explain() JSON or mongosh output. Get a heat-mapped plan tree, findings, and index advice — including ESR mistakes and COLLSCAN traps."
      audience="For backend engineers tuning MongoDB queries before they ship."
      features={[
        {
          icon: 'lock',
          title: 'Browser-private paste',
          body: 'Explain output never leaves your machine. Paste JSON or mongosh text and analyze locally.',
        },
        {
          icon: 'account_tree',
          title: 'Interactive plan tree',
          body: 'Heat-mapped stages so COLLSCAN, SORT, and expensive branches stand out immediately.',
        },
        {
          icon: 'database',
          title: 'Index advice',
          body: 'Findings call out ESR mistakes and ship a ready createIndexes command when you need one.',
        },
      ]}
      slides={[
        {
          title: 'Expensive plan stats',
          caption: 'COLLSCAN and in-memory sort light up as bad before you dig into the tree.',
          preview: (
            <MockFrame title="Stats">
              <div className="mock-stats">
                <MockStat label="Docs examined" value="2.4M" tone="bad" />
                <MockStat label="Stage" value="COLLSCAN" tone="bad" />
                <MockStat label="Sort" value="in-mem" tone="warn" />
              </div>
              <MockBars
                items={[
                  { label: 'docsExamined', w: 96, tone: 'bad' },
                  { label: 'keysExamined', w: 12 },
                  { label: 'nReturned', w: 8 },
                ]}
              />
            </MockFrame>
          ),
        },
        {
          title: 'Plan tree',
          caption: 'Walk the winning plan — SORT over COLLSCAN is hard to miss.',
          preview: (
            <MockFrame title="Winning plan">
              <div className="mock-tree">
                <div><b>SORT</b> · memLimit · 48 MB</div>
                <div>└─ <b>COLLSCAN</b> · orders · docsExamined 2.4M</div>
                <div>&nbsp;&nbsp;&nbsp;&nbsp;filter: {'{ status: "open", ts: { $gte } }'}</div>
              </div>
            </MockFrame>
          ),
        },
        {
          title: 'Index advice',
          caption: 'Findings explain the miss and hand you a createIndexes command.',
          preview: (
            <MockFrame title="Findings">
              <MockList
                items={[
                  { badge: 'Bad', text: 'COLLSCAN — no index covers filter + sort (ESR)', tone: 'bad' },
                  { badge: 'Warn', text: 'In-memory SORT spilled past allowDiskUse hint', tone: 'warn' },
                  { badge: 'Fix', text: 'db.orders.createIndex({ status: 1, ts: 1 })', tone: 'info' },
                ]}
              />
            </MockFrame>
          ),
        },
      ]}
    />
  )
}

export default function App() {
  return <RouteApp landing={<ProductLanding />} tool={<Tool />} />
}
