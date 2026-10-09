import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DESTRUCTIVE_SQL_STATEMENTS, findDestructiveSql } from '../destructiveSql.js'

const VECTORS = fileURLToPath(new URL('../../fixtures/destructive-sql-vectors.json', import.meta.url))

interface Vector {
  text: string
  statement: string | null
  dbWrite: boolean
}

const doc = JSON.parse(readFileSync(VECTORS, 'utf8')) as { rule: { source: string }; cases: Vector[] }

describe('destructive SQL text rule', () => {
  it('has the shared vectors to run, one or more per statement', () => {
    expect(doc.cases.length).toBeGreaterThanOrEqual(40)
    for (const s of DESTRUCTIVE_SQL_STATEMENTS) {
      expect(doc.cases.some((v) => v.statement === s.statement), `no vector for ${s.statement}`).toBe(true)
    }
  })

  it('is the phrase set the hook gates ship', () => {
    expect(doc.rule.source.split('|')).toEqual(DESTRUCTIVE_SQL_STATEMENTS.map((s) => s.phrase))
  })

  it.each(doc.cases.map((v) => [JSON.stringify(v.text), v] as const))('%s', (_, v) => {
    expect(findDestructiveSql(v.text).map((s) => s.statement)).toEqual(v.statement ? [v.statement] : [])
  })
})
