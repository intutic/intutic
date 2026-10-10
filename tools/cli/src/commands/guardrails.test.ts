/**
 * `intutic guardrails` — the wire path, headers and body
 * of each command are pinned against a stubbed `fetch`, the way
 * `findings.test.ts` does it. The client validates what the server would
 * refuse before any request is made, and a 409 prints the server's own
 * readiness reasons.
 */
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'

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
  runGuardrailsImpact,
  runGuardrailsDuplicates,
  runGuardrailsCreate,
  runGuardrailsUpdate,
  runGuardrailsDelete,
  runGuardrailsDocsShow,
  runGuardrailsSourcesSync,
} from './guardrails.js'

// Real credential files in a throwaway home, read by the real config store —
// no module mock. `os.homedir()` reads HOME on every call, so the commands
// resolve this directory; the only stub is `fetch`.
const realHome = process.env.HOME
const realDev = process.env.INTUTIC_DEV
const home = mkdtempSync(path.join(os.tmpdir(), 'intutic-guardrails-cli-'))

beforeAll(() => {
  process.env.HOME = home
  delete process.env.INTUTIC_DEV
  mkdirSync(path.join(home, '.intutic'), { recursive: true })
  writeFileSync(path.join(home, '.intutic', 'credentials.json'), JSON.stringify({ apiKey: 'vk_test_key', workspaceId: 'ws_test' }), { mode: 0o600 })
})

afterAll(() => {
  process.env.HOME = realHome
  if (realDev !== undefined) process.env.INTUTIC_DEV = realDev
  rmSync(home, { recursive: true, force: true })
})

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
  provenance: 'extracted',
  name: null,
  description: null,
  version: 1,
  supersedes: null,
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

  it('a settings-class guardrail prints the setting it writes, and for egress that it applies without shadow evidence', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        guardrail: {
          ...summary({ guardrailId: 'pgr_e', target: 'workspace_setting', status: 'PROPOSED', ir: { kind: 'egress_allow', hosts: ['artifacts.internal.example.com'] }, rendered: { kind: 'workspace_setting', key: 'egressAllow', values: ['artifacts.internal.example.com'] } }),
          validation: [],
          passage: null,
          events: [],
        },
      }),
    )
    await runGuardrailsShow('pgr_e', {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const out = printed()
    expect(out).toContain('egressAllow: artifacts.internal.example.com')
    expect(out).toContain('No shadow evidence exists for egress')
    expect(out).toContain('monitor or enforce')
  })

  it('--target accepts workspace_setting', async () => {
    fetchMock.mockResolvedValue(ok({ guardrails: [] }))
    await runGuardrailsList({ target: 'workspace_setting' })
    expect(new URL(fetchMock.mock.calls[0]![0] as string).searchParams.get('target')).toBe('workspace_setting')
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

describe('intutic guardrails sources sync', () => {
  // What POST /api/v1/connectors/:connectorId/sync answers (routes/connectors.ts).
  const SYNCED = { success: true, processed_docs: 7, updated_sops: ['sop_a', 'sop_b'], successor_sops: ['sop_c'] }

  it('prints what the route returns', async () => {
    fetchMock.mockResolvedValue(ok(SYNCED))
    await runGuardrailsSourcesSync('conn_1', {})
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/v1/connectors/conn_1/sync')
    expect(printed()).toMatch(/Documents processed.*7/)
    expect(printed()).toMatch(/SOPs written.*2/)
    expect(printed()).toMatch(/Upstream successors.*1 draft\(s\) for review: sop_c/)
  })

  it('--json prints the response as is', async () => {
    fetchMock.mockResolvedValue(ok(SYNCED))
    await runGuardrailsSourcesSync('conn_1', { json: true })
    expect(JSON.parse(printed())).toEqual(SYNCED)
  })
})

describe('intutic guardrails role refusals', () => {
  // What requireRole answers: `error` says only "Forbidden"; `detail` names
  // the roles that may make the call.
  const FORBIDDEN = { error: 'Forbidden', code: 'E_FORBIDDEN', detail: 'Requires the OWNER or ADMIN role' }

  it.each([
    ['create', () => runGuardrailsCreate({ kind: 'tool_deny', tool: 'Bash', name: 'No shell' } as never)],
    ['update', () => runGuardrailsUpdate('pgr_1', { name: 'Renamed' } as never)],
    ['delete', () => runGuardrailsDelete('pgr_1', {})],
    ['promote', () => runGuardrailsPromote('pgr_1', {})],
    ['docs extract', () => runGuardrailsDocsExtract('pdoc_1', {})],
    ['show', () => runGuardrailsShow('pgr_1', {})],
    ['docs show', () => runGuardrailsDocsShow('pdoc_1', {})],
  ])('%s prints the roles that may, not just "Forbidden"', async (_name, run) => {
    fetchMock.mockResolvedValue(ok(FORBIDDEN, 403))
    await swallowExit(run())
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(fetchMock).toHaveBeenCalled()
    expect(errors()).toContain('Requires the OWNER or ADMIN role')
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

  it('replay names an egress allow list\'s missing source instead of reporting zero fires as a measurement', async () => {
    fetchMock.mockResolvedValue(ok({ replay: { source: 'none', windowDays: 30, captured: 0, fires: 0, sample: [], truncated: false, unsupported: ["egress_allow: no egress observation source; would-deny decisions stay in the proxy's local log"] } }))
    await runGuardrailsReplay('pgr_e', {})
    expect(printed()).toContain('nothing captured can answer this')
    expect(printed()).toContain('no egress observation source')
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

  it('sources add reads a Google service-account key from --token-file and refuses an ambiguous credential', async () => {
    await swallowExit(runGuardrailsSourcesAdd('gdrive', { name: 'policies' }))
    expect(fetchMock).not.toHaveBeenCalled()
    await swallowExit(runGuardrailsSourcesAdd('gdrive', { name: 'policies', token: 'a', tokenFile: 'b' }))
    expect(fetchMock).not.toHaveBeenCalled()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-gdrive-'))
    const keyPath = path.join(dir, 'key.json')
    // No PEM here on purpose: the credential body is whatever the file holds, and the secret scan refuses a real one in source.
    await fs.writeFile(keyPath, '{"type":"service_account","client_email":"reader@acme.iam.gserviceaccount.com"}\n')
    fetchMock.mockResolvedValue(ok({ connector: { connector_id: 'cc_g', provider: 'gdrive', name: 'policies' } }, 201))
    await runGuardrailsSourcesAdd('gdrive', { name: 'policies', tokenFile: keyPath, config: '{"folder_id":"1AbC"}' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ provider: 'gdrive', name: 'policies', token: '{"type":"service_account","client_email":"reader@acme.iam.gserviceaccount.com"}', config: { folder_id: '1AbC' } })
    expect(printed()).toContain('cc_g')
    await fs.rm(dir, { recursive: true, force: true })
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

describe('intutic guardrails search --text / impact / duplicates', () => {
  it('search --text hits the full-text endpoint with the words encoded', async () => {
    fetchMock.mockResolvedValue(ok({ search: { query: 'production deploy', passages: [{ passageId: 'p', docId: 'd', title: 'Change policy', sourceUrl: null, headingPath: ['Rules'], excerpt: 'Every production deploy…', rank: 0.2 }] } }))
    await runGuardrailsSearch('production deploy', { text: true })
    const u = new URL(fetchMock.mock.calls[0]![0] as string)
    expect(u.pathname).toBe('/api/v1/policy-guardrails/search')
    expect(u.searchParams.get('q')).toBe('production deploy')
    expect(printed()).toContain('Every production deploy')
  })

  it('impact needs exactly one seed, then prints the guardrails it reaches and warns about an enforcing one', async () => {
    await swallowExit(runGuardrailsImpact({}))
    await swallowExit(runGuardrailsImpact({ doc: 'psd_1', passage: 'pps_1' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errors()).toContain('exactly one of --doc')

    fetchMock.mockResolvedValue(ok({ impact: { seed: { docId: 'psd_1', passageId: null }, maxDepth: 5, passages: [{ passageId: 'pps_1', docId: 'psd_1', title: 'Change policy', depth: 0, retired: false, excerpt: 'x' }], clauses: [{ clauseId: 'pcl_1', passageId: 'pps_1', docId: 'psd_1', kind: 'hook_rule', quote: 'q', depth: 0 }], guardrails: [{ guardrailId: 'pgr_1', clauseId: 'pcl_1', status: 'ENFORCING', target: 'hook_rule', sourceStale: false, ruleCandidateId: null, depth: 0 }], truncated: false } }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runGuardrailsImpact({ doc: 'psd_1' })
    const u = new URL(fetchMock.mock.calls[0]![0] as string)
    expect(u.pathname).toBe('/api/v1/policy-guardrails/impact')
    expect(u.searchParams.get('docId')).toBe('psd_1')
    expect(printed()).toContain('pgr_1 [ENFORCING] hook_rule, 0 edge(s) from the change')
    const warned = [...warn.mock.calls, ...logSpy.mock.calls, ...errSpy.mock.calls].map((c: unknown[]) => String(c[0])).join('\n')
    expect(warned).toContain('never switches enforcement off')
  })

  it('duplicates validates --min-jaccard before any request and prints both sides of a pair', async () => {
    await swallowExit(runGuardrailsDuplicates({ minJaccard: 'high' }))
    await swallowExit(runGuardrailsDuplicates({ minJaccard: '1.5' }))
    expect(fetchMock).not.toHaveBeenCalled()

    const side = (id: string, title: string) => ({ passageId: id, docId: `d_${id}`, title, excerpt: `${title} excerpt`, guardrailIds: [] })
    fetchMock.mockResolvedValue(ok({ duplicates: { minJaccard: 0.85, passagePairs: [{ jaccard: 0.91, intersection: 30, union: 33, nearIdentical: true, a: side('pps_a', 'Handbook'), b: side('pps_b', 'Runbook') }], sameRule: [] } }))
    await runGuardrailsDuplicates({ minJaccard: '0.85' })
    expect(new URL(fetchMock.mock.calls[0]![0] as string).searchParams.get('minJaccard')).toBe('0.85')
    const out = printed()
    expect(out).toContain('Handbook and Runbook (30 of 33 shingles shared)')
    expect(out).toContain('pps_b: Runbook excerpt')
  })
})

const authoredDetail = (over: Record<string, unknown> = {}) => ({
  ...summary({
    guardrailId: 'pgr_a',
    provenance: 'authored',
    name: 'Reviewed terraform apply',
    description: 'Production applies need a reviewed plan.',
    status: 'PROPOSED',
    clause: null,
    document: null,
    ...over,
  }),
  validation: [],
  passage: null,
  events: [],
  supersededBy: null,
})

const HOOK = { kind: 'hook_rule', title: 'Reviewed plan before terraform apply', tools: ['Bash'], argContains: ['terraform apply'] }

describe('intutic guardrails create / update / delete (authored)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-authored-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  const sent = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit]
    return { path: new URL(url).pathname, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined }
  }

  it('create from a YAML envelope posts name, description and the IR as written', async () => {
    const file = path.join(dir, 'g.yaml')
    await fs.writeFile(file, 'name: Reviewed terraform apply\ndescription: Production applies need a reviewed plan.\nir:\n  kind: hook_rule\n  title: Reviewed plan before terraform apply\n  tools: [Bash]\n  argContains: [terraform apply]\n')
    fetchMock.mockResolvedValue(ok({ ok: true, guardrail: authoredDetail(), forked: false, supersedes: null }, 201))
    await runGuardrailsCreate({ file })
    expect(sent()).toEqual({ path: '/api/v1/policy-guardrails/guardrails', method: 'POST', body: { name: 'Reviewed terraform apply', description: 'Production applies need a reviewed plan.', ir: HOOK } })
    expect(printed()).toContain('Created pgr_a (hook_rule), PROPOSED')
    expect(printed()).toContain('intutic guardrails approve-shadow pgr_a')
  })

  it('create from a bare JSON IR takes the name from --name', async () => {
    const file = path.join(dir, 'g.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'deny_tools', tools: ['WebFetch'] }))
    fetchMock.mockResolvedValue(ok({ ok: true, guardrail: authoredDetail({ target: 'sop_front_matter' }), forked: false, supersedes: null }, 201))
    await runGuardrailsCreate({ file, name: 'No web fetch' })
    expect(sent().body).toEqual({ name: 'No web fetch', ir: { kind: 'deny_tools', tools: ['WebFetch'] } })
  })

  it('create from flags builds the IR from --kind and the keys it takes; repeatable literals keep their commas', async () => {
    fetchMock.mockResolvedValue(ok({ ok: true, guardrail: authoredDetail(), forked: false, supersedes: null }, 201))
    await runGuardrailsCreate({ name: 'x', kind: 'hook_rule', title: 'T', tools: 'Bash, Write', argContains: ['a,b'], argNotContains: ['--dry-run'], roles: 'deployer' })
    expect(sent().body.ir).toEqual({ kind: 'hook_rule', title: 'T', tools: ['Bash', 'Write'], argContains: ['a,b'], argNotContains: ['--dry-run'], roles: ['deployer'] })
    fetchMock.mockClear()
    await runGuardrailsCreate({ name: 'x', kind: 'max_calls', token: 'Bash', limit: '20' })
    expect(sent().body.ir).toEqual({ kind: 'max_calls', token: 'Bash', limit: 20 })
    fetchMock.mockClear()
    await runGuardrailsCreate({ name: 'x', kind: 'wasm_predicate', title: 'T', rationale: 'R', predicate: '{"all":[{"field":"depth","op":"atLeast","value":3}]}' })
    expect(sent().body.ir).toEqual({ kind: 'wasm_predicate', title: 'T', rationale: 'R', verdict: 3, predicate: { all: [{ field: 'depth', op: 'atLeast', value: 3 }] } })
  })

  it('refuses before any request what the server would refuse: no IR, no name, an IR flag without --kind, a file and flags at once', async () => {
    await swallowExit(runGuardrailsCreate({ name: 'x' }))
    await swallowExit(runGuardrailsCreate({ kind: 'deny_tools', tools: 'WebFetch' }))
    await swallowExit(runGuardrailsCreate({ name: 'x', tools: 'WebFetch' }))
    const file = path.join(dir, 'g.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'deny_tools', tools: ['WebFetch'] }))
    await swallowExit(runGuardrailsCreate({ name: 'x', file, kind: 'deny_tools', tools: 'Read' }))
    await fs.writeFile(file, JSON.stringify({ name: 'x', ir: {}, extra: 1 }))
    await swallowExit(runGuardrailsCreate({ file }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errors()).toContain('--tools needs --kind')
    expect(errors()).toContain('not both')
    expect(errors()).toContain('unknown key(s) extra')
  })

  it('a validator refusal prints every check and the one that refused, and exits 1', async () => {
    fetchMock.mockResolvedValue(
      ok({ error: 'The guardrail was refused by token_observable: not a harness tool name', code: 'invalid_guardrail', validation: [{ name: 'json_schema', passed: true, detail: 'object' }, { name: 'token_observable', passed: false, detail: 'not a harness tool name and none has been observed yet: kubectl' }] }, 400),
    )
    await swallowExit(runGuardrailsCreate({ name: 'x', kind: 'deny_tools', tools: 'kubectl' }))
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errors()).toContain('refused by token_observable')
    expect(printed()).toContain('✗ token_observable — not a harness tool name')
    expect(printed()).toContain('✓ json_schema')
  })

  it('update sends only what changed, and says when an IR edit forked a new version', async () => {
    fetchMock.mockResolvedValue(ok({ ok: true, guardrail: authoredDetail({ description: 'Second.' }), forked: false, supersedes: null }))
    await runGuardrailsUpdate('pgr_a', { description: 'Second.' })
    expect(sent()).toEqual({ path: '/api/v1/policy-guardrails/guardrails/pgr_a', method: 'PUT', body: { description: 'Second.' } })
    expect(printed()).toContain('updated in place')

    fetchMock.mockResolvedValue(ok({ ok: true, guardrail: authoredDetail({ guardrailId: 'pgr_b', version: 2, supersedes: 'pgr_a' }), forked: true, supersedes: 'pgr_a' }))
    await runGuardrailsUpdate('pgr_a', { kind: 'deny_tools', tools: 'WebFetch' })
    expect(sent(1).body).toEqual({ ir: { kind: 'deny_tools', tools: ['WebFetch'] } })
    expect(printed()).toContain('version 2 is pgr_b, PROPOSED with no evidence. pgr_a is retired.')

    fetchMock.mockResolvedValue(ok({ ok: true, guardrail: authoredDetail({ description: null }), forked: false, supersedes: null }))
    await runGuardrailsUpdate('pgr_a', { clearDescription: true })
    expect(sent(2).body).toEqual({ description: null })
  })

  it('update with nothing to send makes no request; an extracted guardrail\'s 409 is reported', async () => {
    await swallowExit(runGuardrailsUpdate('pgr_a', {}))
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValue(ok({ error: 'an extracted guardrail is read-only: it changes when its document changes', code: 'read_only' }, 409))
    await swallowExit(runGuardrailsUpdate('pgr_1', { name: 'mine' }))
    expect(errors()).toContain('read-only')
  })

  it('delete retires through DELETE, and a missing guardrail exits 1', async () => {
    fetchMock.mockResolvedValueOnce(ok({ ok: true, guardrail: authoredDetail({ status: 'RETIRED' }) }))
    await runGuardrailsDelete('pgr_a', {})
    expect(sent()).toMatchObject({ path: '/api/v1/policy-guardrails/guardrails/pgr_a', method: 'DELETE' })
    expect(printed()).toContain('retired')
    fetchMock.mockResolvedValueOnce(ok({ error: 'Guardrail not found' }, 404))
    await swallowExit(runGuardrailsDelete('pgr_nope', {}))
    expect(errors()).toContain('"pgr_nope" not found')
  })

  it('list and show print an authored guardrail by its name, description and version instead of a citation', async () => {
    fetchMock.mockResolvedValueOnce(ok({ guardrails: [authoredDetail({ version: 2 })] }))
    await runGuardrailsList({ provenance: 'authored' })
    expect(new URL(fetchMock.mock.calls[0]![0] as string).searchParams.get('provenance')).toBe('authored')
    expect(printed()).toContain('authored: Reviewed terraform apply — "Production applies need a reviewed plan.", version 2')
    fetchMock.mockResolvedValueOnce(ok({ guardrail: { ...authoredDetail({ status: 'RETIRED', supersedes: 'pgr_0', version: 2 }), supersededBy: 'pgr_c' } }))
    await runGuardrailsShow('pgr_a', {})
    expect(printed()).toContain('Reviewed terraform apply, version 2 (replaced pgr_0)')
    expect(printed()).toContain('pgr_c — an IR edit created the next version')
    await swallowExit(runGuardrailsList({ provenance: 'typed' }))
    expect(errors()).toContain('extracted, authored')
  })
})
