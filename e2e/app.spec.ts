import type { Locator, Page } from '@playwright/test'
import { test, expect, fixture } from './harness.ts'
import { shardedFind } from './fixtures/sharded.ts'

// Inputs: the built-in synthetic samples, explain output printed in the MongoDB manual (e2e/fixtures/*.txt, see the
// README there for sources) and a synthetic sharded document. Nothing here touches a real database.

const box = (page: Page) => page.getByLabel('MongoDB explain output')
const stat = (page: Page, label: string) => page.locator('.stat', { has: page.getByText(label, { exact: true }) }).locator('.value')
const panel = (page: Page, heading: string) => page.locator('section.panel', { has: page.getByRole('heading', { name: heading, exact: true }) })
const findingTitles = (page: Page) => panel(page, 'Findings').locator('.finding > .row > strong')
const stages = (page: Page) => page.locator('.tree .stage')
const results = (page: Page) => page.locator('.stats')

async function paste(page: Page, text: string) {
  await page.goto('/app')
  await box(page).fill(text)
}

const SAMPLE_CASES = [
  { label: 'COLLSCAN + sort', stages: ['SORT', 'COLLSCAN'], findings: ['Collection scan', 'Blocking in-memory SORT'], advice: 'db.orders.createIndex({ status: 1, region: 1, createdAt: -1 })', health: 'Expensive' },
  { label: 'Wrong ESR order', stages: ['SORT', 'FETCH', 'IXSCAN'], findings: ['Keys examined ≫ returned', 'Documents examined ≫ returned', 'Blocking in-memory SORT'], advice: 'db.orders.createIndex({ status: 1, total: -1, orderDate: 1 })', health: 'Expensive' },
  { label: 'Covered query', stages: ['PROJECTION_COVERED', 'IXSCAN'], findings: ['Covered query', 'No obvious problems'], advice: 'db.inventory.createIndex({ sku: 1, qty: 1 })', health: 'Healthy' },
  { label: 'Aggregation + $lookup', stages: ['PROJECTION_SIMPLE', 'FETCH', 'IXSCAN'], findings: ['$lookup from "customers" on customerId scans the foreign collection', 'In-memory $sort of 31 documents'], advice: 'db.orders.createIndex({ status: 1, createdAt: 1 })', pipeline: 4 },
  { label: '8.3 SBE + cost estimates', stages: ['GROUP', 'FETCH', 'IXSCAN'], findings: ['Cardinality misestimate (20.7×)', 'Index doesn\'t cover the whole predicate'], advice: "db.shipments.createIndex({ status: 1, 'dest.country': 1 })", health: 'Expensive' },
  { label: 'mongosh paste', stages: ['SORT', 'FETCH', 'IXSCAN'], findings: ['Keys examined ≫ returned', 'Blocking in-memory SORT'], advice: 'db.orders.createIndex({ status: 1, total: -1, orderDate: 1 })', health: 'Expensive' },
]

test('landing page leads to the tool, and the docs page renders', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('See why MongoDB')
  await page.getByRole('button', { name: 'Try this' }).first().click()
  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByRole('heading', { name: 'See what MongoDB actually did' })).toBeVisible()
  // Nothing is analysed before there is input.
  await expect(page.getByText('Paste an explain(), drop a file, or load a sample to get started.')).toBeVisible()
  await expect(results(page)).toHaveCount(0)

  await page.goto('/docs')
  await expect(page.getByRole('heading', { name: 'What you can paste' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Privacy and sharing' })).toBeVisible()
})

for (const c of SAMPLE_CASES) {
  test(`sample "${c.label}" shows the plan tree, findings and index advice`, async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: c.label, exact: true }).click()
    await expect(results(page)).toBeVisible()
    await expect(stages(page)).toHaveText(c.stages)
    const titles = await findingTitles(page).allInnerTexts()
    for (const f of c.findings) expect(titles, `findings for ${c.label}`).toContain(f)
    await expect(panel(page, 'Index advice').locator('pre')).toHaveText(c.advice)
    if (c.health) await expect(stat(page, 'Health')).toHaveText(c.health)
    if (c.pipeline) await expect(panel(page, 'Aggregation pipeline').locator('tbody tr')).toHaveCount(c.pipeline)
    await expect(page.locator('.finding.bad, .finding.warn, .finding.info, .finding.good').first()).toBeVisible()
  })
}

test('plan tree nodes can be collapsed and expanded', async ({ page }) => {
  await page.goto('/app')
  await page.getByRole('button', { name: 'COLLSCAN + sort', exact: true }).click()
  await expect(stages(page)).toHaveText(['SORT', 'COLLSCAN'])
  await page.getByRole('button', { name: 'Collapse' }).click()
  await expect(stages(page)).toHaveText(['SORT'])
  await page.getByRole('button', { name: 'Expand' }).click()
  await expect(stages(page)).toHaveText(['SORT', 'COLLSCAN'])
})

test('index advice can be copied', async ({ page }) => {
  await page.goto('/app')
  await page.getByRole('button', { name: 'COLLSCAN + sort', exact: true }).click()
  await panel(page, 'Index advice').getByRole('button', { name: 'Copy' }).click()
  await expect(panel(page, 'Index advice').getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('db.orders.createIndex({ status: 1, region: 1, createdAt: -1 })')
})

test.describe('explain output from the MongoDB manual', () => {
  test('executionStats, no index: COLLSCAN reads 21,349 documents to return 3,809', async ({ page }) => {
    await paste(page, fixture('analyze-query-plan-no-index.txt'))
    await expect(stat(page, 'Verbosity')).toHaveText('executionStats')
    await expect(stat(page, 'Namespace')).toHaveText('sample_mflix.movies')
    await expect(stat(page, 'nReturned')).toHaveText('3,809')
    await expect(stat(page, 'Docs examined')).toHaveText('21,349')
    await expect(stat(page, 'Keys examined')).toHaveText('0')
    await expect(stat(page, 'Health')).toHaveText('Needs attention')
    await expect(page.getByText('6 docs examined per doc returned')).toBeVisible()
    await expect(stages(page)).toHaveText(['COLLSCAN'])
    await expect(findingTitles(page)).toHaveText(['Collection scan'])
    await expect(panel(page, 'Findings').locator('.finding.bad')).toContainText('COLLSCAN reads every document in sample_mflix.movies')
    // The excerpt is hand-trimmed ('...': '...'); that must not be reported as a problem with the paste.
    await expect(page.getByText('Parse error')).toHaveCount(0)
    await expect(page.getByText('Shell output was truncated')).toHaveCount(0)
  })

  test('executionStats, with an index: 3,809 keys and documents for 3,809 returned is healthy', async ({ page }) => {
    await paste(page, fixture('analyze-query-plan-index.txt'))
    await expect(stat(page, 'Health')).toHaveText('Healthy')
    await expect(stat(page, 'nReturned')).toHaveText('3,809')
    await expect(stat(page, 'Docs examined')).toHaveText('3,809')
    await expect(stat(page, 'Keys examined')).toHaveText('3,809')
    await expect(stages(page)).toHaveText(['FETCH', 'IXSCAN'])
    await expect(panel(page, 'Plan tree')).toContainText('{ year: 1 }')
    expect(await findingTitles(page).allInnerTexts()).not.toContain('Collection scan')
    // The excerpt carries no filter or command, so there is nothing to base an index suggestion on.
    await expect(panel(page, 'Index advice')).toHaveCount(0)
  })

  test('executionStats aggregation (SBE): GROUP over COLLSCAN with the pipeline table', async ({ page }) => {
    await paste(page, fixture('aggregation-explain-field.txt'))
    await expect(stat(page, 'Verbosity')).toHaveText('allPlansExecution')
    await expect(stat(page, 'Engine')).toHaveText('SBE (slot-based)')
    await expect(stat(page, 'Namespace')).toHaveText('sample_mflix.comments')
    await expect(stat(page, 'nReturned')).toHaveText('697')
    await expect(stat(page, 'Docs examined')).toHaveText('41,079')
    await expect(stat(page, 'Keys examined')).toHaveText('0')
    await expect(stat(page, 'Time')).toHaveText('31 ms')
    await expect(page.locator('h2', { hasText: 'Overview' })).toContainText('v8.2.2')
    await expect(page.locator('h2', { hasText: 'Overview' }).getByText('aggregation', { exact: true })).toBeVisible()
    await expect(stages(page)).toHaveText(['GROUP', 'COLLSCAN'])
    const titles = await findingTitles(page).allInnerTexts()
    expect(titles).toContain('Collection scan')
    expect(titles).toContain('In-memory $sort of 697 documents')
    await expect(panel(page, 'Index advice').locator('pre')).toHaveText('db.comments.createIndex({ date: 1 })')
    const rows = panel(page, 'Aggregation pipeline').locator('tbody tr')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('$cursor')
    await expect(rows.nth(1)).toContainText('$sort')
  })

  test('queryPlanner only: execution numbers are absent, never zero', async ({ page }) => {
    await paste(page, fixture('aggregation-explain.txt'))
    await expect(stat(page, 'Verbosity')).toHaveText('queryPlanner')
    await expect(stat(page, 'Health')).toHaveText('No exec stats')
    for (const label of ['nReturned', 'Docs examined', 'Keys examined']) await expect(stat(page, label), label).toHaveText('—')
    expect(await findingTitles(page).allInnerTexts()).toContain('No execution statistics')
    // No ratio badge, and no execution counters on any plan node or candidate plan.
    await expect(page.getByText('docs examined per doc returned')).toHaveCount(0)
    await expect(panel(page, 'Plan tree')).not.toContainText(/\b(n|docs|keys)=\d/)
    await expect(stages(page)).toHaveText(['GROUP', 'IXSCAN'])
    const plans = panel(page, 'Candidate plans')
    await expect(plans.locator('tbody tr')).toHaveCount(2)
    for (const row of await plans.locator('tbody tr').all()) {
      // nReturned, keys, docs, ms, cost, works: the last six columns
      await expect(row.locator('td').nth(4)).toHaveText('—')
      await expect(row.locator('td').nth(5)).toHaveText('—')
      await expect(row.locator('td').nth(6)).toHaveText('—')
      await expect(row.locator('td').nth(7)).toHaveText('—')
    }
    await expect(panel(page, 'Index advice')).toContainText('Matches current')
  })

  // https://github.com/AryanKansagara/explainlens/issues/2
  test('queryPlanner only: Time is not shown as 0 ms', async ({ page }) => {
    await paste(page, fixture('aggregation-explain.txt'))
    await expect(stat(page, 'Time')).toHaveText('—')
  })

  test('hand-trimmed executionStats without a time: Time is "—", the numbers that are there stay', async ({ page }) => {
    await paste(page, "{ queryPlanner: { namespace: 'a.b', winningPlan: { stage: 'COLLSCAN' } }, executionStats: { nReturned: 3, executionTimeMillis: '...', totalKeysExamined: 0, totalDocsExamined: 9 } }")
    await expect(stat(page, 'Docs examined')).toHaveText('9')
    await expect(stat(page, 'Time')).toHaveText('—')
  })

  // https://github.com/AryanKansagara/explainlens/issues/3
  test('queryPlanner only: no "No obvious problems" verdict without statistics (known bug #3)', async ({ page }) => {
    test.fail(true, 'issue #3: "No obvious problems" is shown for explains without stats or plans')
    await paste(page, fixture('aggregation-explain.txt'))
    await expect(stat(page, 'Verbosity')).toHaveText('queryPlanner')
    expect(await findingTitles(page).allInnerTexts()).not.toContain('No obvious problems')
  })
})

test('a real zero is still shown as zero when executionStats says so', async ({ page }) => {
  await paste(page, JSON.stringify({
    queryPlanner: { namespace: 'a.b', winningPlan: { stage: 'IXSCAN', indexName: 'a_1', keyPattern: { a: 1 } } },
    executionStats: { nReturned: 0, totalKeysExamined: 0, totalDocsExamined: 0, executionTimeMillis: 0 },
  }))
  await expect(stat(page, 'Verbosity')).toHaveText('executionStats')
  for (const label of ['nReturned', 'Docs examined', 'Keys examined']) await expect(stat(page, label), label).toHaveText('0')
  await expect(stat(page, 'Time')).toHaveText('0 ms')
})

test('sharded find (synthetic, documented layout): scatter-gather across both shards', async ({ page }) => {
  await paste(page, JSON.stringify(shardedFind, null, 2))
  await expect(page.locator('h2', { hasText: 'Overview' }).getByText('sharded', { exact: true })).toBeVisible()
  await expect(stat(page, 'nReturned')).toHaveText('30')
  await expect(stat(page, 'Docs examined')).toHaveText('5,000')
  await expect(stat(page, 'Namespace')).toHaveText('shop.orders')
  const titles = await findingTitles(page).allInnerTexts()
  expect(titles).toContain('Scatter-gather across 2 shards')
  expect(titles.filter((t) => t === 'Collection scan')).toHaveLength(2)
  await expect(stages(page)).toHaveText(['SHARD_MERGE', 'SHARDING_FILTER', 'COLLSCAN', 'SHARDING_FILTER', 'COLLSCAN'])
  await expect(panel(page, 'Plan tree')).toContainText('shardA')
  await expect(panel(page, 'Plan tree')).toContainText('shardB')
  await expect(panel(page, 'Candidate plans').locator('tbody tr')).toHaveCount(2)
  await expect(panel(page, 'Index advice').locator('pre')).toHaveText('db.orders.createIndex({ status: 1 })')
})

test.describe('input that is not a usable explain', () => {
  const NO_RESULT = async (page: Page) => {
    await expect(results(page)).toHaveCount(0)
    await expect(panel(page, 'Findings')).toHaveCount(0)
    await expect(page.getByText('No obvious problems')).toHaveCount(0)
    await expect(page.getByText('Healthy', { exact: true })).toHaveCount(0)
    await expect(panel(page, 'Plan tree')).toHaveCount(0)
  }

  const BAD: { name: string; text: string; message: RegExp }[] = [
    { name: 'plain prose', text: 'hello, this is not an explain', message: /No JSON object found/ },
    { name: 'SQL', text: 'SELECT * FROM orders WHERE id = 1', message: /No JSON object found/ },
    { name: 'a bare number', text: '42', message: /No JSON object found/ },
    { name: 'unrelated JSON object', text: '{"name":"x","items":[1,2,3]}', message: /does not look like explain\(\) output/ },
    { name: 'unrelated JSON array', text: '[1,2,3]', message: /does not look like explain\(\) output/ },
    { name: 'an empty object', text: '{}', message: /does not look like explain\(\) output/ },
    { name: 'an empty array', text: '[]', message: /(No JSON object found|does not look like explain\(\) output)/ },
    { name: 'queryPlanner as a string', text: '{"queryPlanner":"x"}', message: /does not look like explain\(\) output/ },
    { name: 'HTML', text: '<html><body>{queryPlanner}</body></html>', message: /Expected ":"/ },
    { name: 'two documents pasted together', text: '{"queryPlanner":{"winningPlan":{"stage":"COLLSCAN"}}} {"queryPlanner":{}}', message: /Unexpected content after the end of the document/ },
    { name: 'a document cut off inside an object', text: '{ queryPlanner: { namespace: "a.b", winningPlan: { stage: "COLLSCAN"', message: /Expected "," or "\}" after value of "stage".*line 1, column \d+/ },
    { name: 'a document cut off right after a colon', text: '{ queryPlanner: {', message: /Expected a property name.*line 1, column \d+/ },
    { name: 'a document with an unterminated string', text: '{ queryPlanner: { namespace: "a.b', message: /Unterminated string/ },
  ]

  for (const c of BAD) {
    test(`${c.name} gets a parse message and no verdict`, async ({ page }) => {
      await paste(page, c.text)
      const err = page.locator('.finding.bad')
      await expect(err).toHaveCount(1)
      await expect(err).toContainText('Parse error:')
      await expect(err).toContainText(c.message)
      await NO_RESULT(page)
    })
  }

  test('empty and whitespace-only input shows the getting-started hint, not an error or a verdict', async ({ page }) => {
    const hint = page.getByText('Paste an explain(), drop a file, or load a sample to get started.')
    await paste(page, '   \n\t  ')
    await expect(hint).toBeVisible()
    await expect(page.locator('.finding')).toHaveCount(0)
    await NO_RESULT(page)
    await box(page).fill('{ queryPlanner: {')
    await expect(page.locator('.finding.bad')).toContainText('Parse error:')
    await expect(hint).toHaveCount(0)
    await box(page).fill('')
    await expect(hint).toBeVisible()
    await expect(page.locator('.finding')).toHaveCount(0)
    await NO_RESULT(page)
  })

  test('every truncation of a real explain is rejected with a position, never analysed', async ({ page }) => {
    const full = fixture('aggregation-explain-field.txt').trim()
    await page.goto('/app')
    const cuts = [1, 17, 60, 333, 1000, 1999, 2500, 3200, 4100, 5000, 5400, full.length - 40, full.length - 3, full.length - 1]
    for (const n of cuts) {
      await box(page).fill(full.slice(0, n))
      await expect(page.locator('.finding.bad'), `cut at ${n}`).toContainText('Parse error:')
      await expect(page.locator('.finding.bad')).toHaveCount(1)
      await NO_RESULT(page)
    }
    // The untouched document still works afterwards.
    await box(page).fill(full)
    await expect(stat(page, 'nReturned')).toHaveText('697')
    await expect(page.getByText('Parse error')).toHaveCount(0)
  })

  test('a shell prompt around a valid explain is tolerated, and a later bad paste replaces the result', async ({ page }) => {
    await paste(page, `test> db.c.find({ a: 1 }).explain("executionStats")\n${fixture('analyze-query-plan-no-index.txt')}\ntest>`)
    await expect(stat(page, 'Docs examined')).toHaveText('21,349')
    await box(page).fill('{ nope')
    await expect(page.locator('.finding.bad')).toContainText('Parse error:')
    await NO_RESULT(page)
  })

  // https://github.com/AryanKansagara/explainlens/issues/3 : a document with a recognised key but nothing inside it.
  test('an explain skeleton with no plan gets no "No obvious problems" verdict (known bug #3)', async ({ page }) => {
    test.fail(true, 'issue #3: "No obvious problems" is shown for empty explains')
    await paste(page, '{"queryPlanner":{}}')
    await expect(page.getByText('No obvious problems')).toHaveCount(0)
  })
})

test.describe('sharing and persistence', () => {
  const sample = async (page: Page) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'Wrong ESR order', exact: true }).click()
    await expect(stat(page, 'Keys examined')).toHaveText('48,210')
  }

  test('Share stores the paste in the URL fragment, and a reload restores it', async ({ page, context }) => {
    await sample(page)
    const text = await box(page).inputValue()
    await page.getByRole('button', { name: 'Share' }).click()
    await expect(page.getByText('Share link copied to clipboard.')).toBeVisible()
    const url = page.url()
    expect(new URL(url).hash.length).toBeGreaterThan(20)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url)

    await page.reload()
    await expect(box(page)).toHaveValue(text)
    await expect(stat(page, 'Keys examined')).toHaveText('48,210')
    await expect(stages(page)).toHaveText(['SORT', 'FETCH', 'IXSCAN'])

    // The copied link opens the same analysis in a fresh tab.
    const other = await context.newPage()
    await other.goto(url)
    await expect(box(other)).toHaveValue(text)
    await expect(stat(other, 'Docs examined')).toHaveText('12,044')
  })

  test('Share is disabled until there is a paste', async ({ page }) => {
    await page.goto('/app')
    await expect(page.getByRole('button', { name: 'Share' })).toBeDisabled()
    await box(page).fill('{}')
    await expect(page.getByRole('button', { name: 'Share' })).toBeEnabled()
    await box(page).fill('   ')
    await expect(page.getByRole('button', { name: 'Share' })).toBeDisabled()
  })

  test('a share link that cannot be decoded says so instead of showing a result', async ({ page }) => {
    await page.goto('/app#not-a-valid-share-code!!')
    await expect(page.getByText('That share link could not be decoded.')).toBeVisible()
    await expect(box(page)).toHaveValue('')
    await expect(results(page)).toHaveCount(0)
    await expect(page.getByText('No obvious problems')).toHaveCount(0)
  })

  test('Clear empties the paste and the results', async ({ page }) => {
    await sample(page)
    await page.getByRole('button', { name: 'Clear' }).click()
    await expect(box(page)).toHaveValue('')
    await expect(results(page)).toHaveCount(0)
  })

  test('the chosen theme survives a reload', async ({ page }) => {
    await page.goto('/app')
    const mode = () => page.evaluate(() => document.documentElement.dataset.themeMode)
    expect(await mode()).toBe('dark')
    await page.getByRole('button', { name: 'Switch to light theme' }).click()
    expect(await mode()).toBe('light')
    await page.reload()
    expect(await mode()).toBe('light')
    await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible()
  })
})

test('an uploaded explain file is analysed in the browser', async ({ page }) => {
  await page.goto('/app')
  await page.locator('input[type=file]').setInputFiles({ name: 'explain.json', mimeType: 'application/json', buffer: Buffer.from(fixture('analyze-query-plan-no-index.txt')) })
  await expect(stat(page, 'Docs examined')).toHaveText('21,349')
  await expect(stages(page)).toHaveText(['COLLSCAN'])
})

test('every page renders fully with all outside hosts blocked', async ({ page, seen }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.goto('/docs')
  await expect(page.getByRole('heading', { name: 'Tested against real output' })).toBeVisible()
  await page.goto('/app')
  await page.getByRole('button', { name: 'Covered query', exact: true }).click()
  await expect(stages(page)).toHaveText(['PROJECTION_COVERED', 'IXSCAN'])
  // The only outside hosts the app reaches for are the Google web-font hosts named in index.html; all were refused.
  // (The auto fixture in harness.ts additionally fails any test that touches another host or sends data out.)
  expect(seen.blocked.length).toBeGreaterThan(0)
  expect(seen.blocked.every((h) => ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(h))).toBe(true)
})
