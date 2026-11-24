import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test as base, expect } from '@playwright/test'

// Hosts the app tries to reach (web fonts). They are blocked, never fetched: tests must not depend on the network.
const EXPECTED_BLOCKED = ['fonts.googleapis.com', 'fonts.gstatic.com']

type Seen = { blocked: string[]; uploads: string[] }

export const test = base.extend<{ seen: Seen; pageErrors: Error[] }>({
  seen: [async ({ context }, use) => {
    const seen: Seen = { blocked: [], uploads: [] }
    // Everything that is not the local preview server is refused.
    await context.route(/^(?!https?:\/\/127\.0\.0\.1[:/]).*/, (route) => {
      const url = route.request().url()
      // data: and blob: URLs are not network requests.
      if (/^(data|blob):/.test(url)) return route.continue()
      seen.blocked.push(new URL(url).host)
      return route.abort('blockedbyclient')
    })
    // The app promises that explain output never leaves the browser: it must only ever GET its own assets.
    context.on('request', (req) => {
      if (req.url().startsWith('http://127.0.0.1') && (req.method() !== 'GET' || req.postData())) seen.uploads.push(`${req.method()} ${req.url()}`)
    })
    await use(seen)
  }, { auto: true }],

  pageErrors: [async ({ page, seen }, use) => {
    const errors: Error[] = []
    page.on('pageerror', (e) => errors.push(e))
    await use(errors)
    // After the test: nothing threw, nothing outside the known font hosts was requested, nothing was sent anywhere.
    expect(errors, 'uncaught page errors').toEqual([])
    expect(seen.blocked.filter((h) => !EXPECTED_BLOCKED.includes(h)), 'unexpected external requests').toEqual([])
    expect(seen.uploads, 'requests that could carry data out of the browser').toEqual([])
  }, { auto: true }],
})

export { expect }

/** Text of a file under e2e/fixtures. */
export const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
