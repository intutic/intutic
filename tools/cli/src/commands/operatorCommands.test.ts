/**
 * The operator commands (`settings`, `mcp`, `notifications`, `siem`,
 * `compliance coverage`, `usage`, `github webhook`, `inventory`, `gate-liveness`) against a
 * mocked control plane: each sends the request its route expects, prints the
 * response as JSON with `--json`, and on an error response prints the
 * server's message and exits 1.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => ({ devMode: false })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSettingsGet, runSettingsSet, parseSettingValue } from './settings.js'
import { runMcpList, runMcpDecide, runMcpTool } from './mcp.js'
import {
  runNotificationsList,
  runNotificationsCreate,
  runNotificationsUpdate,
  runNotificationsDelete,
  runNotificationsRotateSecret,
} from './notifications.js'
import {
  runSiemList,
  runSiemShow,
  runSiemSources,
  runSiemCreate,
  runSiemUpdate,
  runSiemDelete,
  runSiemRotateSecret,
} from './siem.js'
import { runComplianceCoverage, runComplianceCollect, runComplianceDownload } from './compliance.js'
import { runUsageMembers, runUsageTeams, runUsageBranches, runUsageCommits, runUsagePullRequests } from './usage.js'
import { runGithubWebhookShow, runGithubWebhookRotateSecret } from './github.js'
import { runInventorySummary, runInventoryHarnesses, runInventoryMcpServers, runInventorySkills } from './inventory.js'
import { runGateLiveness } from './gateLiveness.js'

const BASE = 'https://api.test.invalid'
const UPGRADE = { error: 'Upgrade required — this feature requires a Biz Org plan or higher' }
const scratch = () => mkdtempSync(join(tmpdir(), 'intutic-cli-operator-'))

function reply(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  })
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
/** The one request made: its URL, method and parsed JSON body. */
function sent(n = 0): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls[n]
  return { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined }
}

/** Runs `fn`, expecting it to exit 1 having printed an error that contains `message`. */
async function expectFailure(fn: () => Promise<void>, message: string): Promise<void> {
  await expect(fn()).rejects.toThrow('process.exit(1)')
  expect(printedError()).toContain(message)
}

describe('intutic settings', () => {
  const SETTINGS = { workspaceId: 'ws_test', settings: { mcpDefaultPolicy: 'allow', configBodyUpload: false } }

  it('get prints every setting', async () => {
    fetchMock.mockReturnValue(reply(200, SETTINGS))
    await runSettingsGet(undefined, {})
    expect(sent()).toMatchObject({ url: `${BASE}/api/v1/workspace/settings`, method: 'GET' })
    expect(printed()).toContain('mcpDefaultPolicy')
  })

  it('get <key> --json prints only that value', async () => {
    fetchMock.mockReturnValue(reply(200, SETTINGS))
    await runSettingsGet('mcpDefaultPolicy', { json: true })
    expect(JSON.parse(printed())).toBe('allow')
  })

  it('get <key> --json prints null for a setting that is not set', async () => {
    fetchMock.mockReturnValue(reply(200, SETTINGS))
    await runSettingsGet('sso_group_policy', { json: true })
    expect(JSON.parse(printed())).toBeNull()
  })

  it('reads a command-line value as JSON when it parses, else as a string', () => {
    expect(parseSettingValue('deny')).toBe('deny')
    expect(parseSettingValue('true')).toBe(true)
    expect(parseSettingValue('null')).toBeNull()
    expect(parseSettingValue('["a","b"]')).toEqual(['a', 'b'])
  })

  it('set PUTs only the one key', async () => {
    fetchMock.mockReturnValue(reply(200, { updated: true, ...SETTINGS, settings: { ...SETTINGS.settings, mcpDefaultPolicy: 'deny' } }))
    await runSettingsSet('mcpDefaultPolicy', 'deny', {})
    expect(sent()).toEqual({ url: `${BASE}/api/v1/workspace/settings`, method: 'PUT', body: { mcpDefaultPolicy: 'deny' } })
    expect(printed()).toContain('mcpDefaultPolicy updated')
  })

  it('set --file sends the file, and --json prints the response', async () => {
    const file = join(scratch(), 'budgets.json')
    const budgets = { budgets: [{ id: 'gh-daily', scope: 'server', server: 'github', period: 'day', limit: 500 }] }
    writeFileSync(file, JSON.stringify(budgets))
    const response = { updated: true, workspaceId: 'ws_test', settings: { mcpBudgets: budgets } }
    fetchMock.mockReturnValue(reply(200, response))
    await runSettingsSet('mcpBudgets', undefined, { file, json: true })
    expect(sent().body).toEqual({ mcpBudgets: budgets })
    expect(JSON.parse(printed())).toEqual(response)
  })

  it('refuses a budgets file the shared schema rejects, naming the field, before any request', async () => {
    const file = join(scratch(), 'budgets.json')
    writeFileSync(file, JSON.stringify({ budgets: [{ id: 'gh', scope: 'tool', server: 'github', period: 'day', limit: 5 }] }))
    await expectFailure(() => runSettingsSet('mcpBudgets', undefined, { file }), 'mcpBudgets.budgets.0.tool')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends PII detector actions, and refuses an unknown action naming the detector, before any request', async () => {
    await expectFailure(() => runSettingsSet('piiDetectors', '{"pii.card":"warn"}', {}), 'piiDetectors.pii.card')
    expect(fetchMock).not.toHaveBeenCalled()

    const actions = { 'pii.card': 'block', 'pii.email': 'redact' }
    fetchMock.mockReturnValue(reply(200, { updated: true, workspaceId: 'ws_test', settings: { piiDetectors: actions } }))
    await runSettingsSet('piiDetectors', JSON.stringify(actions), {})
    expect(sent()).toEqual({ url: `${BASE}/api/v1/workspace/settings`, method: 'PUT', body: { piiDetectors: actions } })
  })

  it('sends the retry setting from a file, and refuses one past the proxy ceilings naming the field, before any request', async () => {
    await expectFailure(() => runSettingsSet('upstreamRetry', '{"maxAttempts":9}', {}), 'upstreamRetry.maxAttempts')
    expect(fetchMock).not.toHaveBeenCalled()

    const setting = { budgetMs: 45000, fallbacks: { 'claude-opus-4-1': [{ model: 'claude-sonnet-4-5' }] } }
    const file = join(scratch(), 'retry.json')
    writeFileSync(file, JSON.stringify(setting))
    fetchMock.mockReturnValue(reply(200, { updated: true, workspaceId: 'ws_test', settings: { upstreamRetry: setting } }))
    await runSettingsSet('upstreamRetry', undefined, { file })
    expect(sent()).toEqual({ url: `${BASE}/api/v1/workspace/settings`, method: 'PUT', body: { upstreamRetry: setting } })
  })

  it('refuses a value given both ways', async () => {
    await expectFailure(() => runSettingsSet('configBodyUpload', 'true', { file: 'x.json' }), 'not both')
  })

  it('prints the server\'s plan refusal for the group policy', async () => {
    fetchMock.mockReturnValue(reply(403, UPGRADE))
    await expectFailure(
      () => runSettingsSet('sso_group_policy', '{"highRiskTools":["Bash"],"requiredGroups":["eng"]}', {}),
      'Upgrade required',
    )
  })
})

describe('intutic mcp', () => {
  const SERVER = {
    serverId: 'mcps_1', serverName: 'github', status: 'candidate', tools: ['create_issue', 'delete_repo'],
    disabledTools: [], lastSeenAt: '2026-10-08T00:00:00Z', heldForReview: false,
  }

  it('list prints the registry and its default policy', async () => {
    fetchMock.mockReturnValue(reply(200, { servers: [SERVER], defaultPolicy: 'deny', highRiskToolChange: 'hold', pendingCount: 1 }))
    await runMcpList({})
    expect(sent().url).toBe(`${BASE}/api/v1/mcp/servers`)
    expect(printed()).toContain('mcps_1')
    expect(printed()).toContain('deny')
  })

  it('list --json prints the response', async () => {
    const res = { servers: [], defaultPolicy: 'allow', highRiskToolChange: 'notify', pendingCount: 0 }
    fetchMock.mockReturnValue(reply(200, res))
    await runMcpList({ json: true })
    expect(JSON.parse(printed())).toEqual(res)
  })

  it.each([
    ['approve', 'approved'],
    ['block', 'blocked'],
    ['reset', 'candidate'],
  ] as const)('%s posts status %s', async (action, status) => {
    fetchMock.mockReturnValue(reply(200, { ok: true, server: { ...SERVER, status } }))
    await runMcpDecide(action, 'mcps_1', {})
    expect(sent()).toEqual({ url: `${BASE}/api/v1/mcp/servers/mcps_1/status`, method: 'POST', body: { status } })
  })

  it('disable-tool and enable-tool post the tool switch', async () => {
    fetchMock.mockReturnValue(reply(200, { ok: true, server: SERVER }))
    await runMcpTool('mcps_1', 'delete_repo', false, {})
    await runMcpTool('mcps_1', 'delete_repo', true, {})
    expect(sent(0)).toEqual({ url: `${BASE}/api/v1/mcp/servers/mcps_1/tools`, method: 'POST', body: { tool: 'delete_repo', enabled: false } })
    expect(sent(1).body).toEqual({ tool: 'delete_repo', enabled: true })
  })

  it('prints the server\'s refusal', async () => {
    fetchMock.mockReturnValue(reply(404, { error: 'MCP server not found' }))
    await expectFailure(() => runMcpDecide('approve', 'mcps_gone', {}), 'MCP server not found')
  })
})

describe('intutic notifications', () => {
  const RULE = {
    ruleId: 'nr_1', eventType: 'incident.created', channel: 'webhook',
    channelConfig: { webhookUrl: 'https://hooks.example.com/x' }, filters: {}, cooldownMinutes: 15, enabled: true,
  }

  it('list prints the rules', async () => {
    fetchMock.mockReturnValue(reply(200, { rules: [RULE] }))
    await runNotificationsList({})
    expect(sent().url).toBe(`${BASE}/api/v1/notifications/rules`)
    expect(printed()).toContain('nr_1')
  })

  it('create sends the rule and prints the webhook signing secret once', async () => {
    fetchMock.mockReturnValue(reply(201, { ...RULE, signingSecret: 'whsec_shown_once' }))
    await runNotificationsCreate({
      event: 'incident.created', channel: 'webhook', webhookUrl: 'https://hooks.example.com/x',
      severity: 'high, critical', cooldown: '30',
    })
    expect(sent()).toEqual({
      url: `${BASE}/api/v1/notifications/rules`,
      method: 'POST',
      body: {
        eventType: 'incident.created', channel: 'webhook', channelConfig: { webhookUrl: 'https://hooks.example.com/x' },
        filters: { severity: ['high', 'critical'] }, cooldownMinutes: 30,
      },
    })
    expect(printed()).toContain('whsec_shown_once')
  })

  it('create maps each channel flag to its config key', async () => {
    fetchMock.mockReturnValue(reply(201, { ...RULE, channel: 'email', channelConfig: { emailRecipients: ['a@x.test'] } }))
    await runNotificationsCreate({ event: 'decision.pending', channel: 'email', email: 'a@x.test,b@x.test', disabled: true })
    expect(sent().body).toMatchObject({ channelConfig: { emailRecipients: ['a@x.test', 'b@x.test'] }, enabled: false })
  })

  it('create refuses an unknown channel before any request', async () => {
    await expectFailure(() => runNotificationsCreate({ event: 'incident.created', channel: 'sms' }), '--channel must be one of')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('update sends only the fields given', async () => {
    fetchMock.mockReturnValue(reply(200, { ...RULE, enabled: false }))
    await runNotificationsUpdate('nr_1', { disable: true, json: true })
    expect(sent()).toEqual({ url: `${BASE}/api/v1/notifications/rules/nr_1`, method: 'PUT', body: { enabled: false } })
    expect(JSON.parse(printed())).toMatchObject({ ruleId: 'nr_1', enabled: false })
  })

  it('update with nothing to change sends nothing', async () => {
    await expectFailure(() => runNotificationsUpdate('nr_1', {}), 'Nothing to update')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('delete and rotate-secret call their routes', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { ok: true }))
    fetchMock.mockReturnValueOnce(reply(200, { ruleId: 'nr_1', signingSecret: 'whsec_new' }))
    await runNotificationsDelete('nr_1', {})
    await runNotificationsRotateSecret('nr_1', {})
    expect(sent(0)).toMatchObject({ url: `${BASE}/api/v1/notifications/rules/nr_1`, method: 'DELETE' })
    expect(sent(1)).toMatchObject({ url: `${BASE}/api/v1/notifications/rules/nr_1/signing-secret`, method: 'POST' })
    expect(printed()).toContain('whsec_new')
  })

  it('prints the server\'s refusal', async () => {
    fetchMock.mockReturnValue(reply(400, { error: 'Only webhook rules are signed' }))
    await expectFailure(() => runNotificationsRotateSecret('nr_slack', {}), 'Only webhook rules are signed')
  })
})

describe('intutic siem', () => {
  const DEST = {
    destinationId: 'siemdest_1', name: 'Splunk', adapterType: 'splunk_hec', isActive: true, sourceTables: [],
    batchSize: 100, flushIntervalMs: 60000, lastHeartbeatAt: null, lastError: null,
  }
  const LIST = { items: [DEST], sources: { all: ['governance_incidents', 'gate_decisions'], defaults: ['governance_incidents'] } }

  it('list prints the destinations', async () => {
    fetchMock.mockReturnValue(reply(200, LIST))
    await runSiemList({})
    expect(sent().url).toBe(`${BASE}/api/v1/siem/destinations`)
    expect(printed()).toContain('siemdest_1')
  })

  it('show --json prints the destination', async () => {
    fetchMock.mockReturnValue(reply(200, DEST))
    await runSiemShow('siemdest_1', { json: true })
    expect(sent().url).toBe(`${BASE}/api/v1/siem/destinations/siemdest_1`)
    expect(JSON.parse(printed())).toEqual(DEST)
  })

  it('sources lists every source and marks the opt-in ones', async () => {
    fetchMock.mockReturnValue(reply(200, LIST))
    await runSiemSources({})
    expect(printed()).toMatch(/gate_decisions.*opt-in/)
    expect(printed()).not.toMatch(/governance_incidents.*opt-in/)
  })

  it('create reads the adapter config from a file', async () => {
    const config = join(scratch(), 'splunk.json')
    writeFileSync(config, JSON.stringify({ hecUrl: 'https://splunk.example.com:8088', token: 'hec-token' }))
    fetchMock.mockReturnValue(reply(201, DEST))
    await runSiemCreate({ name: 'Splunk', type: 'splunk_hec', config, sources: 'governance_incidents,gate_decisions' })
    expect(sent()).toEqual({
      url: `${BASE}/api/v1/siem/destinations`,
      method: 'POST',
      body: {
        name: 'Splunk', adapterType: 'splunk_hec', config: { hecUrl: 'https://splunk.example.com:8088', token: 'hec-token' },
        sourceTables: ['governance_incidents', 'gate_decisions'],
      },
    })
  })

  it('create prints a webhook destination\'s signing secret', async () => {
    const config = join(scratch(), 'webhook.json')
    writeFileSync(config, JSON.stringify({ webhookUrl: 'https://siem.example.com/in' }))
    fetchMock.mockReturnValue(reply(201, { ...DEST, adapterType: 'webhook_https', signingSecret: 'whsec_dest' }))
    await runSiemCreate({ name: 'Hook', type: 'webhook_https', config })
    expect(printed()).toContain('whsec_dest')
  })

  it('create refuses an unknown adapter type before any request', async () => {
    await expectFailure(() => runSiemCreate({ name: 'X', type: 'kafka', config: 'x.json' }), '--type must be one of')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('update --default-sources sends an empty source list, and --enable reactivates', async () => {
    fetchMock.mockReturnValue(reply(200, DEST))
    await runSiemUpdate('siemdest_1', { defaultSources: true, enable: true })
    expect(sent()).toEqual({
      url: `${BASE}/api/v1/siem/destinations/siemdest_1`, method: 'PUT', body: { sourceTables: [], isActive: true },
    })
  })

  it('delete and rotate-secret call their routes', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { success: true, destinationId: 'siemdest_1', isActive: false }))
    fetchMock.mockReturnValueOnce(reply(200, { destinationId: 'siemdest_1', signingSecret: 'whsec_rot' }))
    await runSiemDelete('siemdest_1', {})
    await runSiemRotateSecret('siemdest_1', {})
    expect(sent(0)).toMatchObject({ url: `${BASE}/api/v1/siem/destinations/siemdest_1`, method: 'DELETE' })
    expect(sent(1)).toMatchObject({ url: `${BASE}/api/v1/siem/destinations/siemdest_1/signing-secret`, method: 'POST' })
    expect(printed()).toContain('whsec_rot')
  })

  it('prints the server\'s plan refusal', async () => {
    fetchMock.mockReturnValue(reply(403, UPGRADE))
    await expectFailure(() => runSiemList({}), 'Upgrade required')
  })
})

describe('intutic compliance collect and download', () => {
  const ARCHIVE = { runId: 's2r_1', periodStart: '2026-07-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', overallScore: 80, manifest: { archiveSha256: 'ab' }, signature: null }
  const UNSIGNED = { runId: 's2r_1', archive: ARCHIVE, artifactUrl: null, signed: false, unsignedReason: 'Unsigned: this deployment has no signing key.' }

  it('collect posts the period and says when the archive is unsigned', async () => {
    fetchMock.mockReturnValue(reply(200, UNSIGNED))
    await runComplianceCollect({ from: '2026-07-01', to: '2026-10-01' })
    expect(sent()).toEqual({ url: `${BASE}/api/v1/compliance/soc2-collect`, method: 'POST', body: { periodStart: '2026-07-01', periodEnd: '2026-10-01' } })
    expect(printed()).toContain('s2r_1')
    expect(logSpy.mock.calls.flat().map(String).join('\n')).toContain('Unsigned: this deployment has no signing key.')
  })

  it('collect --out writes the archive, also with --json', async () => {
    const out = join(scratch(), 'evidence.json')
    fetchMock.mockReturnValue(reply(200, UNSIGNED))
    await runComplianceCollect({ out, json: true })
    expect(sent().body).toEqual({})
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(ARCHIVE)
    expect(JSON.parse(printed())).toEqual(UNSIGNED)
  })

  it('collect refuses a period it cannot read before any request', async () => {
    await expectFailure(() => runComplianceCollect({ from: 'last quarter' }), '--from must be an ISO 8601 date')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('download writes the stored archive to --out', async () => {
    const out = join(scratch(), 'run.json')
    fetchMock.mockReturnValue(reply(200, ARCHIVE))
    await runComplianceDownload('s2r_1', { out })
    expect(sent().url).toBe(`${BASE}/api/v1/compliance/soc2-export/s2r_1`)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(ARCHIVE)
  })

  it('prints the server\'s role refusal', async () => {
    fetchMock.mockReturnValue(reply(403, { error: 'Forbidden', detail: 'Requires the OWNER or ADMIN role' }))
    await expectFailure(() => runComplianceDownload('s2r_1', {}), 'OWNER or ADMIN')
  })
})

describe('intutic compliance coverage', () => {
  const COVERAGE = {
    frameworkId: 'eu_ai_act', name: 'EU AI Act', mappingVersion: '2026-09', generatedAt: '2026-10-08T00:00:00Z',
    summary: { controls: 12, mapped: 10, full: 6, partial: 4, states: { failing: 1, evidenced: 9 } },
  }
  let stdoutSpy: MockInstance<typeof process.stdout.write>
  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  it('prints a summary by default', async () => {
    fetchMock.mockReturnValue(reply(200, COVERAGE))
    await runComplianceCoverage('eu_ai_act', {})
    expect(sent().url).toBe(`${BASE}/api/v1/compliance/frameworks/eu_ai_act/coverage`)
    expect(printed()).toContain('EU AI Act')
  })

  it('--json prints the coverage as JSON', async () => {
    fetchMock.mockReturnValue(reply(200, COVERAGE))
    await runComplianceCoverage('eu_ai_act', { json: true })
    expect(sent().url).toBe(`${BASE}/api/v1/compliance/frameworks/eu_ai_act/coverage?format=json`)
    expect(JSON.parse(String(stdoutSpy.mock.calls.map((c: unknown[]) => Buffer.from(c[0] as Uint8Array).toString()).join('')))).toEqual(COVERAGE)
  })

  it('--format md asks for markdown and writes it to stdout', async () => {
    fetchMock.mockReturnValue(reply(200, '# EU AI Act coverage\n'))
    await runComplianceCoverage('eu_ai_act', { format: 'md' })
    expect(sent().url).toBe(`${BASE}/api/v1/compliance/frameworks/eu_ai_act/coverage?format=markdown`)
    expect(Buffer.from(stdoutSpy.mock.calls[0][0]).toString()).toBe('# EU AI Act coverage\n')
  })

  it('--format pdf --out writes the bytes to the file', async () => {
    const out = join(scratch(), 'eu.pdf')
    fetchMock.mockReturnValue(reply(200, '%PDF-1.7 bytes'))
    await runComplianceCoverage('eu_ai_act', { format: 'pdf', out })
    expect(sent().url).toBe(`${BASE}/api/v1/compliance/frameworks/eu_ai_act/coverage?format=pdf`)
    expect(readFileSync(out, 'utf8')).toBe('%PDF-1.7 bytes')
  })

  it('refuses an unknown format before any request', async () => {
    await expectFailure(() => runComplianceCoverage('eu_ai_act', { format: 'docx' }), '--format must be one of')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prints the server\'s refusal', async () => {
    fetchMock.mockReturnValue(reply(404, { error: 'Unknown framework; expected one of: eu_ai_act, iso_42001' }))
    await expectFailure(() => runComplianceCoverage('sox', { format: 'csv' }), 'Unknown framework')
  })
})

describe('intutic usage', () => {
  const TOTALS = { totalCostUsd: 1.5, totalRawCostUsd: 1.5, totalInputTokens: 1000, totalOutputTokens: 200, traceCount: 7 }

  it('members asks for the period and says when it is the caller\'s own row only', async () => {
    fetchMock.mockReturnValue(reply(200, {
      scope: 'self',
      members: [{ memberId: 'mem_1', displayName: 'Ana', email: 'ana@x.test', models: [], activeDays: 3, ...TOTALS }],
    }))
    await runUsageMembers({ period: 'daily' })
    expect(sent().url).toBe(`${BASE}/api/v1/usage/members?period=daily`)
    expect(printed()).toContain('Ana')
    expect(printed()).toContain('Your own calls only')
  })

  it('teams says when the workspace has no SCIM groups', async () => {
    fetchMock.mockReturnValue(reply(200, { scimGroups: false, teams: [] }))
    await runUsageTeams({ period: 'monthly' })
    expect(sent().url).toBe(`${BASE}/api/v1/usage/teams?period=monthly`)
    expect(printed()).toContain('no SCIM groups')
  })

  it('branches and commits --json print the response', async () => {
    const branches = { scope: 'workspace', branches: [{ repo: 'github.com/acme/app', branch: 'main', commitCount: 2, lastCallAt: 'x', ...TOTALS }] }
    const commits = { scope: 'workspace', commits: [] }
    fetchMock.mockReturnValueOnce(reply(200, branches)).mockReturnValueOnce(reply(200, commits))
    await runUsageBranches({ period: 'monthly', json: true })
    await runUsageCommits({ period: 'monthly', json: true })
    expect(sent(1).url).toBe(`${BASE}/api/v1/usage/commits?period=monthly`)
    expect(logSpy.mock.calls.map((c: unknown[]) => JSON.parse(String(c[0])))).toEqual([branches, commits])
  })

  it('refuses an unknown period before any request', async () => {
    await expectFailure(() => runUsageMembers({ period: 'weekly' }), '--period must be daily or monthly')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prints the server\'s plan refusal', async () => {
    fetchMock.mockReturnValue(reply(403, UPGRADE))
    await expectFailure(() => runUsageMembers({ period: 'monthly' }), 'Upgrade required')
  })
})

describe('intutic usage pull-requests', () => {
  const TOTALS = { totalCostUsd: 4.25, totalRawCostUsd: 5, totalInputTokens: 1000, totalOutputTokens: 200, traceCount: 12 }
  const github = { connector: true, webhook: false, apiHost: 'github.com', noAccessRepos: [] as string[], mappedPullRequests: 1, lastCheckedAt: null }
  const pr = {
    repo: 'github.com/acme/app', number: 7, title: 'Retry checkout', author: 'priya', state: 'merged', headBranch: 'feat/retry', baseBranch: 'main',
    url: 'https://github.com/acme/app/pull/7', openedAt: 'x', mergedAt: 'y', closedAt: 'y', memberCount: 2, firstCallAt: 'x', lastCallAt: 'y', ...TOTALS,
  }

  it('prints each pull request with its cost', async () => {
    fetchMock.mockReturnValue(reply(200, { scope: 'workspace', github, pullRequests: [pr] }))
    await runUsagePullRequests({ period: 'daily' })
    expect(sent().url).toBe(`${BASE}/api/v1/usage/pull-requests?period=daily`)
    expect(printed()).toContain('github.com/acme/app#7 Retry checkout [merged]')
    expect(printed()).toContain('$4.2500')
    expect(printed()).toContain('2 developers')
  })

  it('--refresh looks the branches up first, then reads; --json prints the usage response only', async () => {
    const body = { scope: 'workspace', github, pullRequests: [pr] }
    fetchMock
      .mockReturnValueOnce(reply(200, { checked: 3, notModified: 2, pullRequests: 1, noAccess: 0, rateLimited: false }))
      .mockReturnValueOnce(reply(200, body))
    await runUsagePullRequests({ period: 'monthly', refresh: true, json: true })
    expect(sent(0)).toMatchObject({ url: `${BASE}/api/v1/usage/pull-requests/refresh`, method: 'POST' })
    expect(sent(1).url).toBe(`${BASE}/api/v1/usage/pull-requests?period=monthly`)
    expect(JSON.parse(String(logSpy.mock.calls[0]![0]))).toEqual(body)
  })

  it('says what is missing when there is nothing to show', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { scope: 'workspace', github: { ...github, connector: false }, pullRequests: [] }))
    await runUsagePullRequests({ period: 'monthly' })
    expect(printed()).toContain('No GitHub connection')

    fetchMock.mockReturnValueOnce(reply(200, { scope: 'workspace', github: { ...github, mappedPullRequests: 0, noAccessRepos: ['github.com/acme/private'] }, pullRequests: [] }))
    await runUsagePullRequests({ period: 'monthly' })
    expect(printedError() + printed()).toContain('Pull requests: Read')
  })
})

describe('intutic github webhook', () => {
  it('show prints the payload URL, or how to set it up', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { configured: false, url: null, createdAt: null, secretRotatedAt: null, lastDeliveryAt: null }))
    await runGithubWebhookShow({})
    expect(sent().url).toBe(`${BASE}/api/v1/integrations/github/webhook`)
    expect(printed()).toContain('rotate-secret')

    fetchMock.mockReturnValueOnce(reply(200, { configured: true, url: 'https://api.test.invalid/api/v1/webhooks/github/ghh_1', createdAt: 'x', secretRotatedAt: 'x', lastDeliveryAt: null }))
    await runGithubWebhookShow({})
    expect(printed()).toContain('https://api.test.invalid/api/v1/webhooks/github/ghh_1')
  })

  it('rotate-secret prints the secret once, with the URL', async () => {
    fetchMock.mockReturnValue(reply(201, { url: 'https://api.test.invalid/api/v1/webhooks/github/ghh_1', secret: 'abc123' }))
    await runGithubWebhookRotateSecret({})
    expect(sent()).toMatchObject({ url: `${BASE}/api/v1/integrations/github/webhook/secret`, method: 'POST' })
    expect(printed()).toContain('abc123')
  })

  it('prints the server\'s role refusal', async () => {
    fetchMock.mockReturnValue(reply(403, { error: 'Forbidden' }))
    await expectFailure(() => runGithubWebhookRotateSecret({}), 'Forbidden')
  })
})

describe('intutic inventory', () => {
  it('summary prints the counts', async () => {
    fetchMock.mockReturnValue(reply(200, { data: {
      devices: 4, staleDevices: 1, harnesses: 6, governedHarnesses: 3, governedPercent: 50, ungovernedHarnesses: 2,
      staleGates: 1, unverifiedHarnesses: 0, mcpServers: 5, ungovernedMcpServers: 2, skills: 9,
    } }))
    await runInventorySummary({})
    expect(sent().url).toBe(`${BASE}/api/v1/inventory/summary`)
    expect(printed()).toContain('50%')
  })

  it('harnesses passes the filters to the route', async () => {
    const res = { data: [{ hostname: 'ana-mbp', harness: 'cursor', version: '1.2', status: 'ungoverned', reasonText: 'No gate', deviceStale: false }] }
    fetchMock.mockReturnValue(reply(200, res))
    await runInventoryHarnesses({ status: 'ungoverned', harness: 'cursor', search: 'ana', json: true })
    expect(sent().url).toBe(`${BASE}/api/v1/inventory/harnesses?status=ungoverned&harness=cursor&q=ana`)
    expect(JSON.parse(printed())).toEqual(res)
  })

  it('mcp-servers --csv --out writes the CSV the route serves', async () => {
    const out = join(scratch(), 'mcp.csv')
    fetchMock.mockReturnValue(reply(200, 'Machine,MCP server\nana-mbp,github\n'))
    await runInventoryMcpServers({ csv: true, out, device: 'dev_1' })
    expect(sent().url).toBe(`${BASE}/api/v1/inventory/mcp-servers?device=dev_1&format=csv`)
    expect(readFileSync(out, 'utf8')).toBe('Machine,MCP server\nana-mbp,github\n')
  })

  it('skills passes the machine and text filters, and prints each bundle\'s scan', async () => {
    const skill = { hostname: 'ana-mbp', name: 'deploy', source: '.claude/skills', sha256: null, deviceStale: false, scriptCount: 2 }
    fetchMock.mockReturnValue(reply(200, { data: [
      { ...skill, scanned: true, clean: false, findingsCount: 1 },
      { ...skill, name: 'release', scanned: false, clean: false, findingsCount: 0 },
    ] }))
    await runInventorySkills({ device: 'dev_1', search: 'ana' })
    expect(sent().url).toBe(`${BASE}/api/v1/inventory/skills?device=dev_1&q=ana`)
    expect(printed()).toMatch(/ana-mbp {2}deploy \(\.claude\/skills\).*1 finding\b/)
    expect(printed()).toMatch(/release.*not readable/)
  })

  it('skills --json prints the response', async () => {
    const res = { data: [] }
    fetchMock.mockReturnValue(reply(200, res))
    await runInventorySkills({ json: true })
    expect(sent().url).toBe(`${BASE}/api/v1/inventory/skills`)
    expect(JSON.parse(printed())).toEqual(res)
  })

  it('prints the server\'s refusal', async () => {
    fetchMock.mockReturnValue(reply(403, { error: 'Forbidden: requires one of OWNER, ADMIN, EM, DEVELOPER' }))
    await expectFailure(() => runInventorySummary({}), 'Forbidden')
  })
})

describe('intutic gate-liveness', () => {
  const RES = {
    windowHours: 24,
    gates: [{ harnessType: 'claude_code', status: 'silent', lastSeen: null, agentLastSeen: '2026-10-07T00:00:00Z', alertOpen: true }],
  }

  it('prints each harness\'s gate and any open alert', async () => {
    fetchMock.mockReturnValue(reply(200, RES))
    await runGateLiveness({})
    expect(sent().url).toBe(`${BASE}/api/v1/governance/gate-liveness`)
    expect(printed()).toContain('claude_code')
    expect(printed()).toContain('silent-gate alert open')
  })

  it('--json prints the response', async () => {
    fetchMock.mockReturnValue(reply(200, RES))
    await runGateLiveness({ json: true })
    expect(JSON.parse(printed())).toEqual(RES)
  })

  it('prints the server\'s refusal', async () => {
    fetchMock.mockReturnValue(reply(403, { error: 'Forbidden: requires one of OWNER, ADMIN, EM' }))
    await expectFailure(() => runGateLiveness({}), 'Forbidden')
  })
})
