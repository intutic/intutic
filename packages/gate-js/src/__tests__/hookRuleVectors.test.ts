/**
 * The SDK gate is the fourth matcher a generated hook rule reaches (LLD #71):
 * the control plane's `matchSopRule`, the MCP proxy's `PolicyClient.matchRule`
 * and the emitted harness gates already run the shared vector file; this runs
 * it through the gate-js rule parser and matcher, over the same serialisation
 * every mirror matches against. A vector this matcher reads differently goes
 * red here and nowhere else.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseRules, ruleMatches, serialiseToolInput } from '../soprules.js'

interface HookVector {
  name: string
  rendered: { toolPattern: string; argPattern?: string; reason: string }
  cases: Array<{ tool: string; toolInput: Record<string, unknown>; fires: boolean }>
}

const VECTORS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../shared-types/fixtures/hook-rule-vectors.json')
const vectors: HookVector[] = (JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as { vectors: HookVector[] }).vectors

describe('hook-rule vectors through the gate-js matcher', () => {
  it('reads a non-empty vector file', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(8)
    expect(vectors.reduce((n, v) => n + v.cases.length, 0)).toBeGreaterThanOrEqual(35)
  })

  for (const v of vectors) {
    it(v.name, () => {
      // Through the real envelope parser, the way the gate receives /api/v1/sop/rules.
      const [rule] = parseRules({ rules: [{ id: 'guardrail.pgr_vector', toolPattern: v.rendered.toolPattern, ...(v.rendered.argPattern ? { argPattern: v.rendered.argPattern } : {}), action: 'block', reason: v.rendered.reason }] })
      expect(rule, 'the parser kept the rule').toBeDefined()
      expect(rule!.argPattern).toBe(v.rendered.argPattern ?? null)
      for (const c of v.cases) {
        expect(ruleMatches(rule!, c.tool, serialiseToolInput(c.toolInput)), `${c.tool} ${JSON.stringify(c.toolInput)}`).toBe(c.fires)
      }
    })
  }
})
