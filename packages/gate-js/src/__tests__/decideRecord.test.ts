/**
 * The snapshot's decide records in the gate SDK: this package carries a
 * byte-identical copy of the shared module, and runs the shared `record`
 * vectors through it.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decideRuleHash, validateDecideRule } from '../decide.js'
import { decodeDecideRecord, decodeSnapshotFormatRecord, encodeDecideRecord } from '../decideRecord.js'

const FIXTURES = join(__dirname, '../../../shared-types/fixtures')
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- typed by the shared-types test; only replayed here
const V = JSON.parse(readFileSync(join(FIXTURES, 'decide-vectors.json'), 'utf-8')).record as any
const check = (ir: unknown) => {
  const v = validateDecideRule(ir)
  return v.ok ? decideRuleHash(v.rule, (s) => createHash('sha256').update(s, 'utf8').digest('hex')) : null
}

it('carries a byte-identical copy of the shared record module', () => {
  expect(readFileSync(join(__dirname, '../decideRecord.ts'), 'utf-8')).toBe(readFileSync(join(__dirname, '../../../shared-types/src/decideRecord.ts'), 'utf-8'))
})

it('encodes and decodes the shared vectors as they say', () => {
  expect(V.valid.length).toBeGreaterThan(0)
  for (const c of V.format) expect(decodeSnapshotFormatRecord(c.line), c.name).toBe(c.format)
  for (const c of V.valid) {
    expect(encodeDecideRecord(c.record), c.name).toBe(c.line)
    expect(decodeDecideRecord(c.line, check), c.name).toEqual(c.record)
  }
  for (const c of V.damaged) expect(decodeDecideRecord(c.line, check), c.name).toBeNull()
})
