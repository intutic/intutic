/**
 * `intutic tasks` against a mocked control plane: each subcommand sends the
 * request routes/taskManagement.ts expects, the API token is read from
 * `--token` / `--token-file` and never printed, and a Jira connection without
 * an account email is refused before anything is sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => ({ devMode: false })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTasksAdd, runTasksList, runTasksRemove, runTasksTest } from './tasks.js'

const URL_BASE = 'https://api.test.invalid/api/v1/task-management/connections'
// Assembled at runtime: no credential-shaped literal in source.
const FAKE_TOKEN = ['fake', 'task', 'token', 'value'].join('-')

const CONNECTION = {
  connectionId: 'cc_1',
  provider: 'jira',
  baseUrl: 'https://acme.atlassian.net',
  projectKey: 'PROJ',
  status: 'connected',
  lastSyncAt: null,
  createdAt: '2026-10-15T00:00:00.000Z',
}

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
function sent(n = 0): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls[n]
  return { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined }
}

describe('intutic tasks', () => {
  it('list GETs the connections and prints each one', async () => {
    fetchMock.mockReturnValue(reply(200, { items: [CONNECTION], listProperty: 'items', rowCase: 'camel' }))
    await runTasksList({})
    expect(sent()).toMatchObject({ url: URL_BASE, method: 'GET' })
    expect(printed()).toContain('cc_1')
    expect(printed()).toContain('PROJ')
  })

  it('list --json prints the response', async () => {
    fetchMock.mockReturnValue(reply(200, { items: [CONNECTION], listProperty: 'items', rowCase: 'camel' }))
    await runTasksList({ json: true })
    expect(JSON.parse(printed()).items[0].connectionId).toBe('cc_1')
  })

  it('add posts a Jira connection with the account email and the token read from --token-file, never printing it', async () => {
    const tokenFile = join(mkdtempSync(join(tmpdir(), 'intutic-tasks-')), 'token')
    writeFileSync(tokenFile, `${FAKE_TOKEN}\n`)
    fetchMock.mockReturnValue(reply(201, CONNECTION))
    await runTasksAdd({ provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKey: 'PROJ', accountEmail: ' dev@example.com ', tokenFile })
    expect(sent()).toEqual({
      url: URL_BASE,
      method: 'POST',
      body: { provider: 'jira', baseUrl: 'https://acme.atlassian.net', authToken: FAKE_TOKEN, projectKey: 'PROJ', metadata: { accountEmail: 'dev@example.com' } },
    })
    expect(printed()).toContain('cc_1')
    expect(printed() + printedError()).not.toContain(FAKE_TOKEN)
  })

  it('add sends no metadata for Linear and takes --token', async () => {
    fetchMock.mockReturnValue(reply(201, { ...CONNECTION, provider: 'linear', projectKey: 'ENG' }))
    await runTasksAdd({ provider: 'linear', baseUrl: 'https://api.linear.app', projectKey: 'ENG', token: FAKE_TOKEN, json: true })
    expect(sent().body).toEqual({ provider: 'linear', baseUrl: 'https://api.linear.app', authToken: FAKE_TOKEN, projectKey: 'ENG' })
    expect(JSON.parse(printed()).provider).toBe('linear')
  })

  it('add refuses a Jira connection without --account-email before sending anything', async () => {
    await expect(runTasksAdd({ provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKey: 'PROJ', token: FAKE_TOKEN })).rejects.toThrow('process.exit(1)')
    expect(printedError()).toContain('--account-email')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('add refuses an unknown provider, a missing or ambiguous token, and --account-email off Jira', async () => {
    const base = { baseUrl: 'https://x.example', projectKey: 'P' }
    await expect(runTasksAdd({ ...base, provider: 'asana', token: FAKE_TOKEN })).rejects.toThrow('process.exit(1)')
    await expect(runTasksAdd({ ...base, provider: 'pagerduty' })).rejects.toThrow('process.exit(1)')
    await expect(runTasksAdd({ ...base, provider: 'pagerduty', token: FAKE_TOKEN, tokenFile: '/nope' })).rejects.toThrow('process.exit(1)')
    await expect(runTasksAdd({ ...base, provider: 'linear', token: FAKE_TOKEN, accountEmail: 'dev@example.com' })).rejects.toThrow('process.exit(1)')
    expect(printedError()).toContain('exactly one of --token or --token-file')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('add prints the server\'s refusal and exits 1', async () => {
    fetchMock.mockReturnValue(reply(400, { error: 'Connection test failed', message: 'Linear did not accept these credentials. Check the Linear API key.' }))
    await expect(runTasksAdd({ provider: 'linear', baseUrl: 'https://api.linear.app', projectKey: 'ENG', token: FAKE_TOKEN })).rejects.toThrow('process.exit(1)')
    expect(printedError()).toContain('Failed to add task connection')
  })

  it('test POSTs the connection\'s test route and exits 1 when the provider refuses', async () => {
    fetchMock.mockReturnValue(reply(200, { success: true, message: 'Connection successful' }))
    await runTasksTest('cc_1', {})
    expect(sent()).toMatchObject({ url: `${URL_BASE}/cc_1/test`, method: 'POST' })
    expect(printed()).toContain('Connection successful')

    fetchMock.mockReturnValue(reply(200, { success: false, message: 'Connection failed. Please check credentials.' }))
    await expect(runTasksTest('cc_1', {})).rejects.toThrow('process.exit(1)')
    expect(printedError()).toContain('Connection failed')
  })

  it('remove DELETEs the connection and exits 1 when the workspace has none with that id', async () => {
    fetchMock.mockReturnValue(reply(200, { deleted: true }))
    await runTasksRemove('cc_1', {})
    expect(sent()).toMatchObject({ url: `${URL_BASE}/cc_1`, method: 'DELETE' })
    expect(printed()).toContain('Removed task connection cc_1')

    fetchMock.mockReturnValue(reply(200, { deleted: false }))
    await expect(runTasksRemove('cc_gone', { json: true })).rejects.toThrow('process.exit(1)')
    expect(printed()).toContain('"deleted": false')
  })
})
