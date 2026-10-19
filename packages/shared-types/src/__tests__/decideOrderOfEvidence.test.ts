/**
 * The order of evidence: the `orderOfEvidence` rows of
 * `fixtures/lane-vectors.json`, one per row of the "may and may not" list,
 * through the decide evaluator with an in-process engine whose answer makes
 * the rule allow, refuse or escalate.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decideRuleHash, validateDecideRule } from '../decide.js'
import type { DecideEngine } from '../decideEngine.js'
import { decideVerdictInOrder, evaluateDecideCall, type DecideCanaryEntry, type DecideRuleEntry } from '../decideEvaluate.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the vectors are typed by use
const V = JSON.parse(readFileSync(join(__dirname, '../../fixtures/lane-vectors.json'), 'utf-8')).orderOfEvidence as any[]
const sha256Hex = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')
const DIGEST = 'sha256:' + 'a'.repeat(64)

const v = validateDecideRule({
  id: 'irreversible-check',
  on: 'tool_call',
  tools: ['Bash'],
  questions: { harmful: { type: 'yes_no', ask: 'Does this command destroy data that cannot be recovered?' } },
  when: 'harmful',
  rollout: 'enforce',
})
if (!v.ok) throw new Error(v.reason)
const RULE: DecideRuleEntry = {
  ref: 'local:lanes.md#irreversible-check',
  ruleHash: decideRuleHash(v.rule, sha256Hex),
  rollout: 'enforce',
  stampedBy: 'rule',
  ir: v.rule,
  sopTitle: 'Lanes',
  ruleText: 'Irreversible actions wait for a person.',
  pins: [{ modelDigest: DIGEST, evalRunId: 'eval_1', source: 'local' }],
}

/** p(yes) that makes the rule's `when` true, false, or unknown. */
const P = { refuse: 0.99, allow: 0.01, escalate: 0.5 } as const

function engine(decide: keyof typeof P, asked: { n: number }): DecideEngine {
  const identity = { model: 'm', modelDigest: DIGEST, digestStrength: 'strong' as const }
  return {
    describe: async () => identity,
    ask: async (_state, questions) => {
      asked.n += 1
      return { ...identity, adapter: 'logprobs', answers: Object.fromEntries(questions.map((q) => [q.name, { name: q.name, type: 'yes_no', p: P[decide], latencyMs: 1 }])) }
    },
    canary: async () => {
      throw new Error('the canary is cached in this test')
    },
  } as DecideEngine
}

describe('the order of evidence', () => {
  it('has one vector per row of the may and may not list', () => {
    expect(V.length).toBeGreaterThanOrEqual(5)
  })

  it.each(V.map((c) => [c.name, c]))('%s', async (_n, c) => {
    const asked = { n: 0 }
    const fresh: DecideCanaryEntry = { url: 'mem', modelDigest: DIGEST, ok: true, atMs: Date.now(), pViolation: 0.99, pClean: 0.01, choiceTop: 'delete_files' }
    const ev = await evaluateDecideCall(
      { deterministic: c.deterministic, tool: 'Bash', toolInput: { command: 'terraform destroy' }, cwd: '/repo', rules: [RULE], deadlineMs: Date.now() + 5000 },
      { engine: engine(c.decide, asked), engineUrl: 'mem', canary: { read: () => fresh, write: () => {} }, sha256Hex },
    )
    expect(asked.n > 0, 'asked').toBe(c.asked)
    expect(decideVerdictInOrder(c.deterministic, asked.n > 0 ? ev.call : null)).toBe(c.outcome)
    if (c.deterministic !== 'allow') expect(ev.call.outcome).not.toBe('allow')
  })
})
