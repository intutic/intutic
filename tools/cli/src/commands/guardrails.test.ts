/**
 * `intutic guardrails` (LLD #71, Wave 6) — the wire path, headers and body
 * of each command are pinned against a stubbed `fetch`, the way
 * `findings.test.ts` does it. The client validates what the server would
 * refuse before any request is made, and a 409 prints the server's own
 * readiness reasons.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => null),
}))
vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import {
  runGuardrailsList,
  runGuardrailsShow,
  runGuardrailsPromote,
  runGuardrailsReject,
  runGuardrailsReplay,
  runGuardrailsSourcesList,
  runGuardrailsSourcesAdd,
  runGuardrailsDocsExtract,
  runGuardrailsSearch,
} from './guardrails.js'

let fetchMock: ReturnType<typeof vi.fn>
// spyOn's inferred type narrows to the mocked implementation's signature, which is
// incompatible with a pre-declared generic annotation (same as the sibling command tests).
/* eslint-disable @typescript-eslint/no-explicit-any */
let exitSpy: any
let logSpy: any
let errSpy: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`)
  }) as never)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const printed = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
const errors = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) })
const swallowExit = async (p: Promise<void>) => {
  try {
    await p
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err
  }
}

const summary = (over: Record<string, unknown> = {}) => ({
  guardrailId: 'pgr_1',
  target: 'hook_rule',
  status: 'SHADOW',
  ir: { kind: 'hook_rule', title: 'Reviewed plan before terraform apply', tools: ['Bash'] },
  rendered: { kind: 'hook_rule', toolPattern: '^Bash$', reason: 'Plan first' },
  roles: [],
  scope: 'workspace',
  shadowEvaluations: 12,
  shadowWouldAct: 1,
  enforcingFires: 0,
  sourceStale: false,
  proposedAt: '2026-09-03T10:00:00.000Z',
  shadowAt: null,
  promotedAt: null,
  rejectedReason: null,
  clause: { clauseId: 'pcl_1', quote: 'Never apply without a plan.', quoteOffset: 0, passageHash: 'a'.repeat(64), passageId: 'pps_1', extractor: 'llm:test' },
  document: { docId: 'psd_1', title: 'Change policy', provider: 'confluence', sourceUrl: 'https://wiki' },
  ...over,
})

describe('intutic guardrails list', () => {
  it('refuses a status the server would refuse, before any request', async () => {
    await swallowExit(runGuardrailsList({ status: 'BOGUS' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errors()).toContain('PROPOSED, SHADOW, ENFORCING, REJECTED, RETIRED')
  })

  it('lists with the filters as query params and the bearer key', async () => {
    fetchMock.mockResolvedValue(ok({ guardrails: [summary()] }))
    await runGuardrailsList({ status: 'SHADOW', target: 'hook_rule', limit: '5' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    const u = new URL(url)
    expect(u.pathname).toBe('/api/v1/policy-guardrails/guardrails')
    expect(u.searchParams.get('status')).toBe('SHADOW')
    expect(u.searchParams.get('target')).toBe('hook_rule')
    expect(u.searchParams.get('limit')).toBe('5')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe('Bearer vk_test_key')
    expect(printed()).toContain('pgr_1 [SHADOW]')
    expect(printed()).toContain('"Never apply without a plan."')
  })

  it('--json prints the raw list', async () => {
    fetchMock.mockResolvedValue(ok({ guardrails: [summary()] }))
    await runGuardrailsList({ json: true })
    expect(JSON.parse(printed())[0].guardrailId).toBe('pgr_1')
  })
})

describe('intutic guardrails show', () => {
  it('prints the citation, the exact stderr line, the readiness reasons and the history', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ guardrail: { ...summary(), validation: [{ name: 'citation_verbatim', passed: true, detail: '' }], passage: null, events: [{ eventId: 'e1', event: 'PROPOSED', actorId: null, detail: {}, createdAt: '2026-09-03T10:00:00.000Z' }] } }))
      .mockResolvedValueOnce(ok({ readiness: { ready: false, reasons: ['12 of 200 shadow evaluations'], neverFired: false, evaluations: 12, wouldAct: 1, wouldActRate: null, adjudicated: 0, adjudicatedRequired: 1, falsePositives: 0, falsePositiveRate: null, thresholds: { minShadowEvaluations: 200, maxWouldActRate: 0.05, minAdjudicatedFires: 10, maxAdjudicatedFalsePositiveRate: 0.01 } } }))
    await runGuardrailsShow('pgr_1', {})
    expect(new URL(fetchMock.mock.calls[1]![0] as string).pathname).toBe('/api/v1/policy-guardrails/guardrails/pgr_1/readiness')
    const out = printed()
    expect(out).toContain('[Intutic Governance] BLOCKED: Plan first [sop.guardrail.pgr_1]')
    expect(out).toContain('12 of 200 shadow evaluations')
    expect(out).toContain('no measured rate')
    expect(out).not.toContain('0.0%')
    expect(out).toContain('PROPOSED (system)')
  })

  it('a missing guardrail exits 1 with a named error', async () => {
    fetchMock.mockResolvedValue(ok({ error: 'Guardrail not found' }, 404))
    await swallowExit(runGuardrailsShow('pgr_nope', {}))
    expect(errors()).toContain('"pgr_nope" not found')
  })
})

describe('intutic guardrails promote', () => {
  it('sends the acknowledgement flag and reports the promotion', async () => {
    fetchMock.mockResolvedValue(ok({ ok: true, guardrail: { ...summary({ status: 'ENFORCING' }), validation: [], passage: null, events: [{ eventId: 'e2', event: 'PROMOTED', actorId: 'mem_1', detail: {}, createdAt: '2026-09-03T11:00:00.000Z' }] }, readiness: { ready: true, reasons: [], neverFired: true, evaluations: 250, wouldAct: 0, wouldActRate: 0, adjudicated: 0, adjudicatedRequired: 0, falsePositives: 0, falsePositiveRate: null, thresholds: { minShadowEvaluations: 200, maxWouldActRate: 0.05, minAdjudicatedFires: 10, maxAdjudicatedFalsePositiveRate: 0.01 } } }))
    await runGuardrailsPromote('pgr_1', { acknowledgeNoTraffic: true })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new URL(url).pathname).toBe('/api/v1/policy-guardrails/guardrails/pgr_1/promote')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ acknowledgeNoTraffic: true })
    expect(printed()).toContain('now ENFORCING')
    expect(printed()).toContain('PROMOTED by mem_1')
  })

  it('a 409 prints the server\'s readiness reasons and exits 1', async () => {
    fetchMock.mockResolvedValue(ok({ error: 'not ready to enforce: 12 of 200 shadow evaluations', code: 'not_ready', readiness: { ready: false, reasons: ['12 of 200 shadow evaluations'], neverFired: false, evaluations: 12, wouldAct: 1, wouldActRate: 0.083, adjudicated: 0, adjudicatedRequired: 1, falsePositives: 0, falsePositiveRate: null, thresholds: { minShadowEvaluations: 200, maxWouldActRate: 0.05, minAdjudicatedFires: 10, maxAdjudicatedFalsePositiveRate: 0.01 } } }, 409))
    await swallowExit(runGuardrailsPromote('pgr_1', {}))
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errors()).toContain('not ready to enforce')
    expect(printed()).toContain('12 of 200 shadow evaluations')
    expect(printed()).toContain('8.3%')
  })

  it('a non-member is refused with the server message', async () => {
    fetchMock.mockResolvedValue(ok({ error: 'a guardrail transition needs a signed-in member; service tokens cannot move enforcement', code: 'not_a_member' }, 403))
    await swallowExit(runGuardrailsPromote('pgr_1', {}))
    expect(errors()).toContain('service tokens cannot move enforcement')
  })
})

describe('intutic guardrails reject / replay', () => {
  it('reject needs a reason and sends it', async () => {
    await swallowExit(runGuardrailsReject('pgr_1', {}))
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValue(ok({ ok: true, guardrail: { ...summary({ status: 'REJECTED' }), validation: [], passage: null, events: [] } }))
    await runGuardrailsReject('pgr_1', { reason: '  duplicates a hand-written SOP ' })
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ reason: 'duplicates a hand-written SOP' })
  })

  it('replay prints N of M and what could not be replayed', async () => {
    fetchMock.mockResolvedValue(ok({ replay: { source: 'context_snapshots', windowDays: 30, captured: 40, fires: 3, sample: [{ toolName: 'Bash', at: '2026-09-03T10:00:00.000Z', excerpt: 'max_calls: Bash <= 20: 21 call(s)' }], truncated: false, unsupported: ['review_before'] } }))
    await runGuardrailsReplay('pgr_1', {})
    expect(new URL(fetchMock.mock.calls[0]![0] as string).pathname).toBe('/api/v1/policy-guardrails/guardrails/pgr_1/replay')
    expect(printed()).toContain('3 of 40 captured call(s)')
    expect(printed()).toContain('review_before')
  })
})

describe('intutic guardrails sources / docs / search', () => {
  it('sources list shows only policy-source providers', async () => {
    fetchMock.mockResolvedValue(ok({ items: [{ connector_id: 'cc_1', provider: 'notion', name: 'runbooks', config: { auto_sync: true } }, { connector_id: 'cc_2', provider: 'mem0', name: 'memory', config: {} }] }))
    await runGuardrailsSourcesList({})
    expect(printed()).toContain('cc_1 — notion, auto-sync')
    expect(printed()).not.toContain('mem0')
    expect(printed()).toContain('1 policy source(s)')
  })

  it('sources add validates the provider and posts the connector', async () => {
    await swallowExit(runGuardrailsSourcesAdd('dropbox', { name: 'x', token: 't' }))
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValue(ok({ connector: { connector_id: 'cc_9', provider: 'github', name: 'policies' } }, 201))
    await runGuardrailsSourcesAdd('github', { name: 'policies', token: 'ghs_fake_token_value', config: '{"repo_url":"acme/policies"}' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new URL(url).pathname).toBe('/api/v1/connectors')
    expect(JSON.parse(String(init.body))).toEqual({ provider: 'github', name: 'policies', token: 'ghs_fake_token_value', config: { repo_url: 'acme/policies' } })
    expect(printed()).toContain('cc_9')
  })

  it('docs extract reports the cap as an exit 1, and a success with its counts', async () => {
    fetchMock.mockResolvedValueOnce(ok({ error: 'Daily extraction cap reached', cap: { count: 51, cap: 50 } }, 429))
    await swallowExit(runGuardrailsDocsExtract('psd_1', {}))
    expect(printed() + errors()).toContain('51 of 50')
    fetchMock.mockResolvedValueOnce(ok({ result: { docId: 'psd_1', runId: 'per_1', extractor: 'llm:test', skipped: null, cap: null, llmUnavailable: false, chunks: 1, proposals: 3, verbatimQuotes: 3, valid: 2, rejected: 1, malformed: 0, guardrails: { proposed: 2, rejectedForInjection: 0, existing: 0 }, lifted: { clauses: 0, valid: 0, errors: [] }, error: null } }))
    await runGuardrailsDocsExtract('psd_1', {})
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({ llm: true })
    expect(printed()).toContain('3 proposal(s) from 1 chunk(s)')
  })

  it('search hits the coverage endpoint with the token encoded', async () => {
    fetchMock.mockResolvedValue(ok({ coverage: { token: 'action:deploy', passages: [{ passageId: 'p', docId: 'd', title: 'Change policy', sourceUrl: null, headingPath: ['Rules'], excerpt: 'Every deploy…' }], guardrails: [] } }))
    await runGuardrailsSearch('action:deploy', {})
    const u = new URL(fetchMock.mock.calls[0]![0] as string)
    expect(u.pathname).toBe('/api/v1/policy-guardrails/coverage')
    expect(u.searchParams.get('token')).toBe('action:deploy')
    expect(printed()).toContain('1 passage(s); 0 guardrail(s)')
  })
})
