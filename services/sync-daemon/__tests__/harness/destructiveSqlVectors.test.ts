/**
 * The hook gates' `destructive.sql_drop` rule against the shared vectors.
 *
 * `packages/shared-types/fixtures/destructive-sql-vectors.json` is the one set
 * of answers the control plane's DLP, the MCP proxy's DLP and both gate SDKs'
 * snapshot readers are tested against. It carries the rule's ERE so the SDK
 * readers run the rule exactly as shipped; this pins that copy to the source
 * and runs it in both dialects a hook gate uses: JavaScript `RegExp` (the JS
 * gates) and `grep -E` (the bash gates), over the command normalised as every
 * gate normalises it.
 */
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DESTRUCTIVE_COMMAND_PATTERNS, NORMALISE_CONTRACT } from '../../src/harness/protectedPaths.js'

const VECTORS = join(__dirname, '../../../../packages/shared-types/fixtures/destructive-sql-vectors.json')
const doc = JSON.parse(readFileSync(VECTORS, 'utf8')) as { ere: string; cases: Array<{ text: string; statement: string | null }> }
const rule = DESTRUCTIVE_COMMAND_PATTERNS.find((p) => p.id === 'destructive.sql_drop')!

describe('destructive.sql_drop against the shared vectors', () => {
  it('carries the rule exactly as shipped', () => {
    expect(rule.ignoreCase).toBe(true)
    expect(doc.ere).toBe(rule.source)
    expect(doc.cases.length).toBeGreaterThanOrEqual(40)
  })

  it.each(doc.cases.map((c) => [JSON.stringify(c.text), c] as const))('the JS gates read %s as its vector says', (_, c) => {
    expect(new RegExp(rule.source, 'i').test(NORMALISE_CONTRACT.js(c.text))).toBe(c.statement !== null)
  })

  it('grep -E, as the bash gates run it, agrees on every vector', async () => {
    // Normalised, each command is one line, so one grep over all of them
    // answers every vector: the line numbers it prints are the matches.
    const lines = doc.cases.map((c) => NORMALISE_CONTRACT.js(c.text))
    expect(lines.every((l) => !l.includes('\n'))).toBe(true)
    const file = join(mkdtempSync(join(tmpdir(), 'intutic-sql-vectors-')), 'commands.txt')
    writeFileSync(file, lines.join('\n') + '\n')
    const run = await promisify(execFile)('grep', ['-n', '-E', '-i', '--', rule.source, file]).catch(
      (err: { code?: number; stdout?: string }) => {
        if (err.code === 1) return { stdout: '' } // no line matched
        throw err
      },
    )
    const matched = new Set(run.stdout.split('\n').filter(Boolean).map((l) => Number(l.split(':')[0]) - 1))
    const disagree = doc.cases.filter((c, i) => matched.has(i) !== (c.statement !== null)).map((c) => c.text)
    expect(disagree).toEqual([])
  })
})
