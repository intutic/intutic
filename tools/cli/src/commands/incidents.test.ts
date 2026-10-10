/**
 * `intutic incidents list|show` against a mocked control plane: the filters
 * reach the route, a severity or type the route would refuse is refused
 * before any request, and the review budget is stated when it withholds
 * incidents.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => ({ devMode: false })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import { runIncidentsList, runIncidentsShow } from './incidents.js'

const BASE = 'https://api.test.invalid'

function reply(status: number, body: unknown) {
  const text = JSON.stringify(body)
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text })
}

let fetchMock: ReturnType<typeof vi.fn>
let logSpy: MockInstance<typeof console.log>
let errSpy: MockInstance<typeof console.error>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
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
const printedError = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
const url = (n = 0) => String(fetchMock.mock.calls[n][0])

const INCIDENT = {
  incident_id: 'gi_1',
  workspace_id: 'ws_test',
  trace_id: null,
  session_id: null,
  severity: 'HIGH',
  anomaly_type: 'WASM_RULE_REFUSED',
  description: "WASM rule 'no-shell' (wasm_1) was refused: its binary is missing.",
  resolution_status: 'OPEN',
  resolved_by: null,
  resolved_at: null,
  escalation_chain: { kind: 'wasm_rule_refused', reason: 'missing', occurrences: 2 },
  created_at: '2026-10-10T09:00:00.000Z',
}
const LIST = (audit = { budget: 25, matched: 1, withheld: 0, overBudget: false }) => ({
  listProperty: 'data',
  rowCase: 'snake',
  data: [{ review_priority: 0.8, ...INCIDENT }],
  meta: { total: audit.matched, page: 1, limit: 20, audit },
})

describe('intutic incidents', () => {
  it('list sends every filter, upper-cased, and prints each incident', async () => {
    fetchMock.mockReturnValue(reply(200, LIST()))
    await runIncidentsList({ status: 'open', severity: 'high', type: 'wasm_rule_refused', page: '2', limit: '50' })
    expect(url()).toBe(`${BASE}/api/v1/incidents?status=OPEN&severity=HIGH&type=WASM_RULE_REFUSED&page=2&limit=50`)
    expect(printed()).toContain('gi_1')
    expect(printed()).toContain('WASM_RULE_REFUSED')
    expect(printed()).toContain('binary is missing')
  })

  it('list --json prints the response as the route sent it', async () => {
    fetchMock.mockReturnValue(reply(200, LIST()))
    await runIncidentsList({ json: true })
    expect(url()).toBe(`${BASE}/api/v1/incidents`)
    expect(JSON.parse(printed())).toEqual(LIST())
  })

  it('list says when the review budget leaves incidents out', async () => {
    fetchMock.mockReturnValue(reply(200, LIST({ budget: 25, matched: 40, withheld: 15, overBudget: true })))
    await runIncidentsList({})
    expect(printed()).toContain('15 not shown')
  })

  it.each([
    [{ type: 'NOT_A_TYPE' }, '--type must be one of'],
    [{ severity: 'urgent' }, '--severity must be one of CRITICAL, HIGH, MEDIUM, LOW'],
    [{ limit: '101' }, '--limit is at most 100'],
    [{ page: '0' }, '--page must be a positive whole number'],
  ])('list refuses %o before any request', async (opts, message) => {
    await expect(runIncidentsList(opts)).rejects.toThrow('process.exit(1)')
    expect(printedError()).toContain(message)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('list accepts the system incident types', async () => {
    fetchMock.mockReturnValue(reply(200, LIST()))
    await runIncidentsList({ type: 'SYSTEM_ANOMALY', json: true })
    expect(url()).toBe(`${BASE}/api/v1/incidents?type=SYSTEM_ANOMALY`)
  })

  it('show prints the whole incident, its escalation details included', async () => {
    fetchMock.mockReturnValue(reply(200, { data: INCIDENT }))
    await runIncidentsShow('gi_1', {})
    expect(url()).toBe(`${BASE}/api/v1/incidents/gi_1`)
    expect(printed()).toContain("WASM rule 'no-shell' (wasm_1) was refused: its binary is missing.")
    expect(printed()).toContain('"occurrences":2')
  })

  it('show prints the server\'s answer for an incident it cannot find', async () => {
    fetchMock.mockReturnValue(reply(404, { error: 'Incident not found' }))
    await expect(runIncidentsShow('gi_missing', {})).rejects.toThrow('process.exit(1)')
    expect(printedError()).toContain('Incident not found')
  })
})
