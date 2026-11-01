// Tolerant parser for explain() output: strict JSON, Extended JSON, and mongosh / legacy shell syntax.

export type Obj = Record<string, any>

export class ParseError extends Error {
  line: number
  col: number
  constructor(message: string, line: number, col: number) {
    super(`${message} (line ${line}, column ${col})`)
    this.line = line
    this.col = col
  }
}

export type Parsed = { value: unknown; warnings: string[] }

const TRUNCATED = '[Truncated]'

/** Parse JSON, Extended JSON, or mongosh-style output into plain JS values. Special BSON types become canonical Extended JSON shapes. */
export function parseLenient(src: string): Parsed {
  const warnings = new Set<string>()
  let i = 0
  // Skip shell prompts / commands. Prefer a `{`/`[` that begins a line so
  // `db.coll.find({ ... }).explain()` on the prompt line is not treated as the document.
  const lineStart = /(?:^|\n)[ \t]*([{[])/.exec(src)
  const start = lineStart ? lineStart.index + lineStart[0].length - 1 : src.search(/[{[]/)
  if (start < 0) throw new ParseError('No JSON object found; paste the full explain() output', 1, 1)
  i = start

  const pos = (at = i) => {
    const before = src.slice(0, at).split('\n')
    return [before.length, before[before.length - 1].length + 1] as const
  }
  const fail = (msg: string, at = i): never => {
    const [l, c] = pos(at)
    throw new ParseError(msg, l, c)
  }
  const near = () => JSON.stringify(src.slice(i, i + 12))

  const ws = () => {
    for (;;) {
      const c = src[i]
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '﻿' || c === ' ') i++
      else if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++ }
      else if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2)
        if (end < 0) fail('Unterminated comment')
        i = end + 2
      } else return
    }
  }

  const ident = () => {
    const m = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*/.exec(src.slice(i, i + 200))
    if (!m) return ''
    i += m[0].length
    return m[0]
  }

  const str = (): string => {
    const q = src[i++]
    let out = ''
    for (;;) {
      if (i >= src.length) fail('Unterminated string', i)
      const c = src[i++]
      if (c === q) return out
      if (c === '\n' && q !== '`') fail('Line break inside string', i - 1)
      if (c !== '\\') { out += c; continue }
      const e = src[i++]
      const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }
      if (e in simple) out += simple[e]
      else if (e === 'u') {
        let hex: string
        if (src[i] === '{') { const end = src.indexOf('}', i); hex = src.slice(i + 1, end); i = end + 1 }
        else { hex = src.slice(i, i + 4); i += 4 }
        if (!/^[0-9a-fA-F]+$/.test(hex)) fail('Invalid \\u escape', i)
        out += String.fromCodePoint(parseInt(hex, 16))
      } else if (e === 'x') { out += String.fromCharCode(parseInt(src.slice(i, i + 2), 16)); i += 2 }
      else if (e === '\r' || e === '\n') { if (e === '\r' && src[i] === '\n') i++ }
      else out += e
    }
  }

  const num = (): number => {
    const m = /^[+-]?(0[xX][0-9a-fA-F]+|(\d[\d_]*\.?[\d_]*|\.\d+)([eE][+-]?\d+)?)n?/.exec(src.slice(i, i + 400))
    if (!m) fail(`Unexpected token ${near()}`)
    i += m![0].length
    const s = m![0].replace(/_/g, '').replace(/n$/, '')
    const sign = s[0] === '-' ? -1 : 1
    const body = s.replace(/^[+-]/, '')
    return sign * (/^0x/i.test(body) ? parseInt(body, 16) : Number(body))
  }

  const regex = () => {
    const at = i++
    let body = ''
    let inClass = false
    for (;;) {
      const c = src[i++]
      if (c === undefined || c === '\n') fail('Unterminated regular expression', at)
      if (c === '\\') { body += c + src[i++]; continue }
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) break
      body += c
    }
    const flags = /^[a-z]*/.exec(src.slice(i))![0]
    i += flags.length
    return { $regex: body, $options: flags }
  }

  const args = (): unknown[] => {
    i++ // (
    const out: unknown[] = []
    for (;;) {
      ws()
      if (src[i] === ')') { i++; return out }
      out.push(value())
      ws()
      if (src[i] === ',') i++
      else if (src[i] !== ')') fail(`Expected "," or ")" in argument list, found ${near()}`)
    }
  }

  const object = (): Obj => {
    i++ // {
    const out: Obj = {}
    for (;;) {
      ws()
      if (src[i] === '}') { i++; return out }
      let key: string
      const c = src[i]
      if (c === '"' || c === "'" || c === '`') key = str()
      else if (/[\d.+-]/.test(c)) key = String(num())
      else {
        key = ident()
        if (!key) fail(`Expected a property name, found ${near()}`)
      }
      ws()
      if (src[i] !== ':') fail(`Expected ":" after property "${key}", found ${near()}`)
      i++
      out[key] = value()
      ws()
      if (src[i] === ',') i++
      else if (src[i] !== '}') fail(`Expected "," or "}" after value of "${key}", found ${near()}`)
    }
  }

  const array = (): unknown => {
    i++ // [
    const out: unknown[] = []
    for (;;) {
      ws()
      if (src[i] === ']') { i++; break }
      if (src.startsWith('...', i)) {
        // mongosh: "... 120 more items"
        while (i < src.length && src[i] !== ']' && src[i] !== '\n') i++
        warnings.add('Some arrays were cut short by the shell ("... N more items"); counts may be incomplete.')
        continue
      }
      if (/^<\d+ empty items?>/.test(src.slice(i, i + 20))) { i = src.indexOf('>', i) + 1; out.push(null) }
      else out.push(value())
      ws()
      if (src[i] === ',') i++
      else if (src[i] !== ']') fail(`Expected "," or "]" in array, found ${near()}`, i)
    }
    // mongosh prints nested values beyond inspectDepth as [Object] / [Array]
    if (out.length === 1 && out[0] === TRUNCATED) return TRUNCATED
    return out
  }

  const call = (name: string, a: any[]): unknown => {
    const base = name.replace(/^(BSON|Number)(?=[A-Z])/, '')
    switch (base) {
      case 'ObjectId': case 'ObjectID': return { $oid: String(a[0] ?? '') }
      case 'ISODate': case 'Date': {
        if (!a.length) return { $date: new Date().toISOString() }
        const d = new Date(a.length > 1 ? Date.UTC(a[0], a[1] ?? 0, a[2] ?? 1, a[3] ?? 0, a[4] ?? 0, a[5] ?? 0) : (a[0] as any))
        return { $date: isNaN(+d) ? String(a[0]) : d.toISOString() }
      }
      case 'Long': case 'Int': case 'Int32': case 'Int64': case 'Double': case 'Long.fromString': case 'Long.fromNumber':
        return a.length ? Number(a[0]) : 0
      case 'Decimal': case 'Decimal128': case 'Decimal128.fromString': return { $numberDecimal: String(a[0]) }
      case 'Timestamp': {
        const o = a[0] && typeof a[0] === 'object' ? a[0] : { t: a[0], i: a[1] }
        return { $timestamp: { t: Number(o.t ?? 0), i: Number(o.i ?? 0) } }
      }
      case 'BinData': return { $binary: { base64: String(a[1] ?? ''), subType: Number(a[0] ?? 0).toString(16).padStart(2, '0') } }
      case 'Binary': case 'Binary.createFromBase64': case 'Binary.createFromHexString':
        return { $binary: { base64: String(a[0] ?? ''), subType: Number(a[1] ?? 0).toString(16).padStart(2, '0') } }
      case 'UUID': return { $uuid: String(a[0] ?? '') }
      case 'MinKey': return { $minKey: 1 }
      case 'MaxKey': return { $maxKey: 1 }
      case 'RegExp': return { $regex: String(a[0] ?? ''), $options: String(a[1] ?? '') }
      case 'DBRef': return { $ref: a[0], $id: a[1] }
      case 'Code': return { $code: String(a[0] ?? '') }
      default: return { $call: name, args: a }
    }
  }

  const value = (): unknown => {
    ws()
    const c = src[i]
    if (c === '{') return object()
    if (c === '[') return array()
    if (c === '"' || c === "'" || c === '`') return str()
    if (c === '/') return regex()
    if (c === '-' || c === '+') {
      if (src.startsWith('Infinity', i + 1)) { i += 9; return c === '-' ? -Infinity : Infinity }
      return num()
    }
    if (c !== undefined && /[\d.]/.test(c)) return num()
    const at = i
    let name = ident()
    if (!name) fail(c === undefined ? 'Unexpected end of input; the output looks cut off' : `Unexpected token ${near()}`)
    if (name === 'new') { ws(); name = ident() || fail('Expected a constructor after "new"', at) }
    ws()
    if (src[i] === '(') return call(name, args() as any[])
    switch (name) {
      case 'true': return true
      case 'false': return false
      case 'null': case 'undefined': return null
      case 'Infinity': return Infinity
      case 'NaN': return NaN
      case 'MinKey': return { $minKey: 1 }
      case 'MaxKey': return { $maxKey: 1 }
      case 'Object': case 'Array':
        warnings.add('The shell truncated deeply nested output ([Object] / [Array]). In mongosh run config.set("inspectDepth", Infinity) or print with EJSON.stringify(...) to see the full plan.')
        return TRUNCATED
    }
    return fail(`Unexpected identifier "${name}"`, at)
  }

  const root = value()
  ws()
  if (src[i] === ';') { i++; ws() }
  // A trailing shell prompt (e.g. `test>`) is fine; anything else is probably two documents pasted together.
  if (i < src.length && !/^\S*>\s*$/.test(src.slice(i))) fail(`Unexpected content after the end of the document: ${near()}`)
  return { value: normalize(root), warnings: [...warnings] }
}

/** Collapse Extended JSON number/date wrappers into plain values. */
export function normalize(v: unknown): any {
  if (Array.isArray(v)) return v.map(normalize)
  if (!v || typeof v !== 'object') return v
  const o = v as Obj
  const keys = Object.keys(o)
  if (keys.length === 1) {
    const k = keys[0]
    if (k === '$numberLong' || k === '$numberInt' || k === '$numberDouble') return Number(o[k])
    if (k === '$date') {
      const d = o[k]
      if (typeof d === 'number' || (d && typeof d === 'object' && '$numberLong' in d)) {
        return { $date: new Date(typeof d === 'number' ? d : Number(d.$numberLong)).toISOString() }
      }
      return o
    }
  }
  const out: Obj = {}
  for (const k of keys) out[k] = normalize(o[k])
  return out
}

/** Compact shell-style rendering of a value, e.g. { status: 'A', qty: { $gt: 5 } }. */
export function show(v: unknown, max = 400): string {
  const s = render(v)
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

const SAFE_KEY = /^[A-Za-z_$][\w$]*$/

function render(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : v > 0 ? 'Infinity' : v < 0 ? '-Infinity' : 'NaN'
  if (typeof v !== 'object') return String(v)
  if (Array.isArray(v)) return `[ ${v.map(render).join(', ')} ]`.replace('[  ]', '[]')
  const o = v as Obj
  if ('$oid' in o) return `ObjectId('${o.$oid}')`
  if ('$date' in o) return `ISODate('${o.$date}')`
  if ('$numberDecimal' in o) return `Decimal128('${o.$numberDecimal}')`
  if ('$minKey' in o) return 'MinKey'
  if ('$maxKey' in o) return 'MaxKey'
  if ('$timestamp' in o) return `Timestamp({ t: ${o.$timestamp.t}, i: ${o.$timestamp.i} })`
  if ('$uuid' in o) return `UUID('${o.$uuid}')`
  if ('$regex' in o && typeof o.$regex === 'string' && Object.keys(o).length <= 2) return `/${o.$regex}/${o.$options ?? ''}`
  const entries = Object.entries(o).map(([k, x]) => `${SAFE_KEY.test(k) ? k : render(k)}: ${render(x)}`)
  return entries.length ? `{ ${entries.join(', ')} }` : '{}'
}

/** Format a count compactly: 1234567 -> 1,234,567. */
export const fmt = (n: number | undefined) => (n === undefined || n === null || Number.isNaN(n) ? '—' : Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 }))
