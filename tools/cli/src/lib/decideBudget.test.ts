/** The per-harness decide budget table and a rule's estimate. */
import { describe, expect, it } from 'vitest'
import type { DecideRule } from '@intutic/shared-types'
import { DECIDE_CHECK_COLD_START_MS, decideBudgets, decideRuleCalls, decideRuleEstimateMs } from './decideBudget.js'

describe('decideBudgets', () => {
  const by = Object.fromEntries(decideBudgets().map((b) => [b.harness, b]))

  it('gives the JS gates 7,300 ms, Windsurf and Muse Code 2,300 ms, and the CLI callers their budget less the cold start', () => {
    for (const h of ['claude-code', 'cursor', 'codex', 'github-copilot', 'grok', 'antigravity', 'openclaw', 'cline', 'pi', 'opencode']) expect(by[h]!.budgetMs).toBe(7300)
    expect(by['windsurf']!.budgetMs).toBe(2300)
    expect(by['muse-code']!.budgetMs).toBe(2300)
    for (const h of ['gemini-cli', 'goose', 'hermes', 'openhands']) expect(by[h]).toMatchObject({ family: 'bash', budgetMs: 3900 - DECIDE_CHECK_COLD_START_MS })
    expect(by['n8n']).toMatchObject({ family: 'n8n', budgetMs: 7300 - DECIDE_CHECK_COLD_START_MS })
  })
})

describe('a rule estimate', () => {
  const rule: DecideRule = {
    id: 'r',
    on: 'tool_call',
    tools: ['Bash'],
    questions: {
      a: { type: 'yes_no', ask: 'Does this command export data?' },
      b: { type: 'choice', ask: 'Where does the data go?', options: ['x', 'y'] },
      c: { type: 'choice', ask: 'Where does the data go?', options: ['x', 'y', 'z'] },
    },
    when: 'a AND b == x AND c == z',
  }

  it('counts one call per yes/no, two orders per choice, three past three options', () => {
    expect(decideRuleCalls(rule)).toBe(1 + 2 + 3)
    expect(decideRuleEstimateMs(rule, 500, 1)).toBe(3000)
    expect(decideRuleEstimateMs(rule, 500, 4)).toBe(1000)
  })
})
