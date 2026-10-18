/**
 * The snapshot's `@format` and `@decide` records against the shared vectors
 * (`fixtures/decide-vectors.json`, group `record`), which the Python gate
 * (`tests/test_decide_vectors.py`) also runs. Then the same vectors through
 * the source the hook gates embed.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { DECIDE_JS_SOURCE, decideRuleHash, validateDecideRule } from '../decide.js'
import {
  DECIDE_RECORD_JS_SOURCE,
  decideFallbackId,
  decideFallbackReason,
  decideRuleText,
  decodeDecideRecord,
  decodeSnapshotFormatRecord,
  encodeDecideRecord,
  encodeSnapshotFormatRecord,
  type DecideRecord,
} from '../decideRecord.js'

interface RecordVectors {
  format: Array<{ name: string; line: string; format: number | null }>
  valid: Array<{ name: string; record: DecideRecord; line: string }>
  damaged: Array<{ name: string; line: string }>
}
const V = JSON.parse(readFileSync(join(import.meta.dirname, '../../fixtures/decide-vectors.json'), 'utf8')) as { record: RecordVectors }
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const check = (ir: unknown) => {
  const v = validateDecideRule(ir)
  return v.ok ? decideRuleHash(v.rule, sha256) : null
}

describe('record vectors', () => {
  it.each(V.record.format.map((c) => [c.name, c] as const))('format: %s', (_n, c) => {
    expect(decodeSnapshotFormatRecord(c.line)).toBe(c.format)
  })

  it.each(V.record.valid.map((c) => [c.name, c] as const))('valid: %s', (_n, c) => {
    expect(encodeDecideRecord(c.record)).toBe(c.line)
    expect(decodeDecideRecord(c.line, check)).toEqual(c.record)
  })

  it.each(V.record.damaged.map((c) => [c.name, c] as const))('damaged: %s', (_n, c) => {
    expect(decodeDecideRecord(c.line, check)).toBeNull()
  })

  it('the writer emits format 2', () => {
    expect(encodeSnapshotFormatRecord()).toBe('@format\t2')
  })
})

describe('identity and text', () => {
  it('names the fallback line as the LLD worked example does', () => {
    expect(decideFallbackId('prod-data-export', 'local:data.md', sha256)).toBe('decide-fallback:prod-data-export@6bcd6b021e7d')
    expect(decideFallbackReason('prod-data-export', 'Production data handling')).toBe(
      'Decide rule prod-data-export (Production data handling): upgrade to Intutic 3.0 to evaluate this rule',
    )
  })

  it('keeps the first 4,096 bytes of a body without splitting a character', () => {
    expect(decideRuleText('a'.repeat(5000))).toBe('a'.repeat(4096))
    const cut = decideRuleText('é'.repeat(2049))
    expect(cut).toBe('é'.repeat(2048))
    expect(new TextEncoder().encode(decideRuleText('ab' + '€'.repeat(1365))).length).toBe(4097 - 3)
  })
})

describe('the source the hook gates embed', () => {
  /** Both sources in a fresh context, with the gate's own `check`, as gateBody.ts emits them. */
  function embedded(): { decode: (line: string) => unknown; format: (line: string) => unknown } {
    const ctx = { sha256, TextEncoder, TextDecoder, atob, btoa, out: null as unknown }
    runInNewContext(
      `${DECIDE_JS_SOURCE}\n${DECIDE_RECORD_JS_SOURCE}\n` +
        `out = { decode: (line) => decodeDecideRecord(line, (ir) => { const v = validateDecideRule(ir); return v.ok ? decideRuleHash(v.rule, sha256) : null }), format: decodeSnapshotFormatRecord }`,
      ctx,
    )
    return ctx.out as ReturnType<typeof embedded>
  }

  it('decodes every vector as the module does', () => {
    const e = embedded()
    for (const c of V.record.format) expect(e.format(c.line), c.name).toBe(c.format)
    for (const c of V.record.valid) expect(JSON.stringify(e.decode(c.line)), c.name).toBe(JSON.stringify(decodeDecideRecord(c.line, check)))
    for (const c of V.record.damaged) expect(e.decode(c.line), c.name).toBeNull()
  })

  it('lists every function decide.ts declares', () => {
    const src = readFileSync(join(import.meta.dirname, '../decide.ts'), 'utf8')
    const declared = [...src.matchAll(/^(?:export )?(?:function|class) (\w+)/gm)].map((m) => m[1]!)
    expect(declared.length).toBeGreaterThan(30)
    for (const name of declared) expect(DECIDE_JS_SOURCE, name).toMatch(new RegExp(`(?:function|class) ${name}\\b`))
  })

  it('lists every function decideRecord.ts declares that the decoders call', () => {
    const src = readFileSync(join(import.meta.dirname, '../decideRecord.ts'), 'utf8')
    const declared = [...src.matchAll(/^(?:export )?function (\w+)/gm)].map((m) => m[1]!)
    const writerOnly = ['encodeSnapshotFormatRecord', 'decideRuleRef', 'decideFallbackId', 'decideFallbackReason', 'decideRuleText', 'decideCanonicalRecordJson', 'encodeDecideRecord']
    for (const name of declared.filter((n) => !writerOnly.includes(n))) expect(DECIDE_RECORD_JS_SOURCE, name).toMatch(new RegExp(`function ${name}\\b`))
  })
})
