import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze } from './analyze.ts'
import { parseLenient } from './parse.ts'
import { SAMPLES } from './samples.ts'
import { encode, decode } from './share.ts'

test('each sample parses and analyzes', () => {
  for (const s of SAMPLES) {
    const { value, warnings } = parseLenient(s.text)
    const a = analyze(value, warnings)
    assert.ok(a.health)
    assert.ok(Array.isArray(a.findings))
    assert.ok(Array.isArray(a.parts))
  }
})

test('collscan sample surfaces COLLSCAN finding and index advice', () => {
  const s = SAMPLES.find((x) => x.id === 'collscan')!
  const { value } = parseLenient(s.text)
  const a = analyze(value)
  assert.equal(a.namespace, 'shop.orders')
  assert.ok(a.findings.some((f) => /COLLSCAN|collection scan|blocking sort/i.test(f.title + f.detail)))
  assert.ok(a.index?.command.includes('createIndex'))
  assert.ok(a.parts[0]?.tree)
})

test('share round-trips paste text', async () => {
  const text = SAMPLES[0].text
  const code = await encode(text)
  assert.equal(await decode(code), text)
})
