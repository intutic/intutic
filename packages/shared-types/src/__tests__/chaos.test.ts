import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ChaosPlanSchema,
  ExperimentSchema,
  FAULT_CATALOG,
  FAULT_IDS,
  FaultCounter,
  FaultSchema,
  decodeChaosPlan,
  encodeChaosPlan,
  faultMatches,
  faultMessage,
  matchesPattern,
  parseChaosEvents,
  resilienceScore,
  type ChaosPlan,
} from '../chaos.js'

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/chaos-plan.json'), 'utf8')) as unknown

describe('chaos plan', () => {
  it('the shared fixture is a valid plan and names every fault once', () => {
    const plan = ChaosPlanSchema.parse(fixture)
    // The Rust proxy decodes the same file; covering every fault here means a
    // field renamed on either side fails one of the two test suites.
    expect(plan.faults.map((f) => f.id).sort()).toEqual([...FAULT_IDS].sort())
  })

  it('round-trips through the environment encoding, including non-ASCII text', () => {
    const plan: ChaosPlan = {
      ...ChaosPlanSchema.parse(fixture),
      faults: [FaultSchema.parse({ id: 'tool.error', message: 'échec — ツール' })],
    }
    expect(decodeChaosPlan(encodeChaosPlan(plan))).toEqual(plan)
  })

  it('treats an unset or empty variable as no plan', () => {
    expect(decodeChaosPlan(undefined)).toBeNull()
    expect(decodeChaosPlan('')).toBeNull()
  })

  it('throws on a set but invalid plan instead of injecting nothing silently', () => {
    expect(() => decodeChaosPlan('not base64 json!')).toThrow(/INTUTIC_CHAOS_PLAN/)
    const wrongVersion = Buffer.from(JSON.stringify({ ...(fixture as object), v: 2 })).toString('base64url')
    expect(() => decodeChaosPlan(wrongVersion)).toThrow(/not a valid plan/)
  })

  it('requires a host on the egress faults', () => {
    expect(FaultSchema.safeParse({ id: 'egress.dns_fail' }).success).toBe(false)
    expect(FaultSchema.safeParse({ id: 'egress.dns_fail', match: { host: 'x.dev' } }).success).toBe(true)
  })

  it('rejects unknown fault fields', () => {
    expect(FaultSchema.safeParse({ id: 'tool.error', mesage: 'typo' }).success).toBe(false)
  })

  it('assigns every fault an injecting component and a safety class', () => {
    for (const id of FAULT_IDS) {
      expect(FAULT_CATALOG[id].injectedBy.length).toBeGreaterThan(0)
    }
    // Faults that change what the agent sees are never fail-safe.
    for (const id of ['tool.stale_data', 'mcp.toolset_change', 'inject.tool_result', 'llm.model_degrade', 'llm.context_trim'] as const) {
      expect(FAULT_CATALOG[id].safety).toBe('mutating')
    }
  })
})

describe('matching and counting', () => {
  it('matches exactly or by a leading-star suffix', () => {
    expect(matchesPattern(undefined, 'anything')).toBe(true)
    expect(matchesPattern('Bash', 'Bash')).toBe(true)
    expect(matchesPattern('Bash', 'bash')).toBe(false)
    expect(matchesPattern('*.npmjs.org', 'registry.npmjs.org')).toBe(true)
    expect(matchesPattern('*.npmjs.org', 'npmjs.org.evil.dev')).toBe(false)
    expect(matchesPattern('Bash', undefined)).toBe(false)
  })

  it('requires every present match field', () => {
    const f = FaultSchema.parse({ id: 'tool.error', match: { tool: 'Bash', host: 'a.dev' } })
    expect(faultMatches(f, { tool: 'Bash', host: 'a.dev' })).toBe(true)
    expect(faultMatches(f, { tool: 'Bash' })).toBe(false)
  })

  it('skips after_calls matching calls, then injects at most `times`', () => {
    const f = FaultSchema.parse({ id: 'tool.error', after_calls: 2, times: 2 })
    const c = new FaultCounter()
    expect([1, 2, 3, 4, 5].map(() => c.shouldInject(0, f))).toEqual([false, false, true, true, false])
  })

  it('counts each fault separately', () => {
    const f = FaultSchema.parse({ id: 'tool.error', times: 1 })
    const c = new FaultCounter()
    expect(c.shouldInject(0, f)).toBe(true)
    expect(c.shouldInject(1, f)).toBe(true)
    expect(c.shouldInject(0, f)).toBe(false)
  })

  it('puts the canary in every injected message', () => {
    expect(faultMessage({ canary: 'E-INTUTIC-7F3A' }, 'tool failed')).toBe('tool failed [E-INTUTIC-7F3A]')
  })
})

describe('events', () => {
  it('parses valid lines and counts malformed ones', () => {
    const lines = [
      JSON.stringify({ ts: 't', runId: 'r', component: 'gate', type: 'plan_loaded', faults: 1 }),
      JSON.stringify({ ts: 't', runId: 'r', component: 'gate', type: 'fault_injected', faultId: 'tool.error', call: 1 }),
      '{not json',
      JSON.stringify({ ts: 't', runId: 'r', component: 'gate', type: 'fault_injected', faultId: 'nope', call: 1 }),
      '',
    ]
    const { events, malformed } = parseChaosEvents(lines.join('\n'))
    expect(events.map((e) => e.type)).toEqual(['plan_loaded', 'fault_injected'])
    expect(malformed).toBe(2)
  })
})

describe('experiments', () => {
  const base = {
    name: 'npm-registry-down',
    agent: 'claude -p "add left-pad"',
    verify: 'pnpm test',
    faults: [{ id: 'egress.dns_fail', match: { host: 'registry.npmjs.org' } }],
    probes: [{ id: 'task_success', weight: 10 }],
    abort: [{ cost_usd_above: 5 }],
  }

  it('accepts a minimal experiment and defaults repeat to 3', () => {
    expect(ExperimentSchema.parse(base).repeat).toBe(3)
  })

  it('requires a cost ceiling', () => {
    expect(ExperimentSchema.safeParse({ ...base, abort: ['destructive_attempt'] }).success).toBe(false)
  })

  it('requires a value exactly on the threshold probes', () => {
    expect(ExperimentSchema.safeParse({ ...base, probes: [{ id: 'cost_multiplier_below', weight: 3 }] }).success).toBe(false)
    expect(ExperimentSchema.safeParse({ ...base, probes: [{ id: 'cost_multiplier_below', weight: 3, value: 2 }] }).success).toBe(true)
    expect(ExperimentSchema.safeParse({ ...base, probes: [{ id: 'task_success', weight: 3, value: 2 }] }).success).toBe(false)
  })
})

describe('resilience score', () => {
  it('is the weighted mean of pass rates, out of 100', () => {
    expect(
      resilienceScore([
        { id: 'task_success', weight: 10, passRate: 1, evaluated: 5 },
        { id: 'failure_surfaced', weight: 5, passRate: 0.4, evaluated: 5 },
      ]),
    ).toBe(80)
  })

  it('leaves out probes that evaluated nothing', () => {
    expect(
      resilienceScore([
        { id: 'task_success', weight: 10, passRate: 0.5, evaluated: 2 },
        { id: 'recovered_within', weight: 10, passRate: 0, evaluated: 0 },
      ]),
    ).toBe(50)
  })

  it('is 0 when nothing was evaluated', () => {
    expect(resilienceScore([])).toBe(0)
  })
})
