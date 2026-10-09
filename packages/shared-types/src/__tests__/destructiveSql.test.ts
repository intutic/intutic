import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DESTRUCTIVE_SQL_PATTERNS, SQL_GAP } from '../destructiveSql.js'

const ACTIONS_RS = fileURLToPath(new URL('../../../proxy/src/plugins/anomaly/actions.rs', import.meta.url))
const VECTORS = fileURLToPath(new URL('../../fixtures/destructive-sql-vectors.json', import.meta.url))

interface Vector {
  text: string
  statement: string | null
  dbWrite: boolean
}

const vectors = (JSON.parse(readFileSync(VECTORS, 'utf8')) as { cases: Vector[] }).cases

describe('destructive SQL text rule', () => {
  it('uses the SQL_GAP of the proxy', () => {
    const m = readFileSync(ACTIONS_RS, 'utf8').match(/const SQL_GAP: &str =\s*r"(.*?)";/s)
    expect(m, 'SQL_GAP not found in actions.rs').not.toBeNull()
    expect(SQL_GAP).toBe(m![1])
  })

  it('has the shared vectors to run', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(40)
    for (const s of DESTRUCTIVE_SQL_PATTERNS) {
      expect(vectors.some((v) => v.statement === s.statement), `no vector for ${s.statement}`).toBe(true)
    }
  })

  it.each(vectors.map((v) => [JSON.stringify(v.text), v] as const))('%s', (_, v) => {
    const found = DESTRUCTIVE_SQL_PATTERNS.filter((p) => p.regex.test(v.text)).map((p) => p.statement)
    expect(found).toEqual(v.statement ? [v.statement] : [])
  })
})
