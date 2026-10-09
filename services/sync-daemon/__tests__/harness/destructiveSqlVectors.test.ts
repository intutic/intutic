/**
 * The hook gates' `destructive.sql_drop` rule against the shared vectors.
 *
 * `packages/shared-types/fixtures/destructive-sql-vectors.json` is the one set
 * of answers the control plane's DLP, the MCP proxy's DLP and both gate SDKs'
 * snapshot readers are tested against. It carries the rule as the snapshot
 * ships it, so the SDK readers run exactly that; this pins the copy to the
 * source and runs the rule the way every gate evaluates it (`guardMatches`).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESTRUCTIVE_COMMAND_PATTERNS, guardMatches } from '../../src/harness/protectedPaths.js'

const VECTORS = join(__dirname, '../../../../packages/shared-types/fixtures/destructive-sql-vectors.json')
const doc = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
  rule: { id: string; subject: string; source: string }
  cases: Array<{ text: string; statement: string | null }>
}
const rule = DESTRUCTIVE_COMMAND_PATTERNS.find((p) => p.id === 'destructive.sql_drop')!

describe('destructive.sql_drop against the shared vectors', () => {
  it('carries the rule exactly as shipped', () => {
    expect(doc.rule).toEqual({ id: rule.id, subject: rule.subject, source: rule.source })
    expect(doc.cases.length).toBeGreaterThanOrEqual(40)
  })

  it.each(doc.cases.map((c) => [JSON.stringify(c.text), c] as const))('the gates read %s as its vector says', (_, c) => {
    expect(guardMatches(rule, c.text)).toBe(c.statement !== null)
  })
})
