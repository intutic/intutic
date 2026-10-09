/**
 * This SDK against the shared destructive-SQL vectors
 * (`packages/shared-types/fixtures/destructive-sql-vectors.json`), the answers
 * every classifier and text rule is held to.
 *
 * - The action classifier: whether a command is `action:db_write`.
 * - The snapshot reader running the hook gates' `destructive.sql_drop` rule,
 *   whose ERE the vector file carries as shipped: whether it fires. The server
 *   tier (`POST /api/v1/hook-gate`) is the control plane's DLP, which runs the
 *   same vectors in its own suite.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classify } from '../actions.js'
import { evaluate, loadSnapshot, SEV_WARN } from '../snapshot.js'

const VECTORS = join(__dirname, '../../../shared-types/fixtures/destructive-sql-vectors.json')
const doc = JSON.parse(readFileSync(VECTORS, 'utf-8')) as {
  ere: string
  cases: Array<{ text: string; statement: string | null; dbWrite: boolean }>
}
const cases = doc.cases.map((c) => [JSON.stringify(c.text), c] as const)

function sqlDropSnapshot() {
  const file = join(mkdtempSync(join(tmpdir(), 'intutic-gate-sql-')), 'policy-snapshot.rules')
  writeFileSync(file, ['destructive.sql_drop', 'warn', 'i', 'command', 'Destructive SQL statement', doc.ere].join('\t') + '\n')
  return loadSnapshot('', file)
}

describe('destructive SQL vectors', () => {
  it('has the vectors to run', () => {
    expect(doc.cases.length).toBeGreaterThanOrEqual(40)
  })

  it.each(cases)('classifies %s as its vector says', (_, c) => {
    expect(classify('bash', { command: c.text }).includes('action:db_write')).toBe(c.dbWrite)
  })

  it.each(cases)('the snapshot rule reads %s as its vector says', (_, c) => {
    const snap = sqlDropSnapshot()
    expect(snap.state).toBe('ok')
    const d = evaluate('bash', '', c.text, snap)
    expect(d.severity).toBe(c.statement ? SEV_WARN : null)
  })
})
