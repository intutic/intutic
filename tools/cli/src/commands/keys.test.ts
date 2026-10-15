/**
 * `intutic keys` against a mocked control plane: each subcommand sends the
 * request `routes/keys.ts` expects, prints the response as JSON with
 * `--json`, refuses a scope outside the registry before sending anything, and
 * on an error response prints the server's message and exits 1.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => ({ devMode: false })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import { runKeysList, runKeysCreate, runKeysUpdate, runKeysRevoke } from './keys.js'

const BASE = 'https://api.test.invalid'

function reply(status: number, body: unknown) {
  const text = JSON.stringify(body)
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  })
}

let fetchMock: ReturnType<typeof vi.fn>
let logSpy: MockInstance<typeof console.log>
let errSpy: MockInstance<typeof console.error>
let warnSpy: MockInstance<typeof console.warn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`)
  }) as never)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const printed = () => [...logSpy.mock.calls, ...warnSpy.mock.calls].map((c: unknown[]) => String(c[0])).join('\n')
const printedError = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
function sent(n = 0): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls[n]
  return { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined }
}
async function expectFailure(fn: () => Promise<void>, message: string): Promise<void> {
  await expect(fn()).rejects.toThrow('process.exit(1)')
  expect(printedError()).toContain(message)
}

const KEY = {
  keyId: 'key_1',
  keyPrefix: 'vk_ab12',
  label: 'CI runner',
  scopes: ['gateway:use', 'traces:read'],
  allowedModels: null,
  expiresAt: '2026-11-14T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  createdAt: '2026-10-15T00:00:00.000Z',
  isServiceAccount: true,
  budgets: [],
  rateLimit: { rpm: null, tpm: null },
}

describe('intutic keys list', () => {
  it('GETs /api/v1/keys and prints each key with its id, label, prefix, scopes and expiry', async () => {
    const never = { ...KEY, keyId: 'key_2', label: 'laptop', keyPrefix: 'vk_cd34', scopes: ['*'], expiresAt: null }
    fetchMock.mockReturnValue(reply(200, { listProperty: 'data', rowCase: 'camel', data: [KEY, never] }))
    await runKeysList({})
    expect(sent()).toMatchObject({ url: `${BASE}/api/v1/keys`, method: 'GET' })
    const out = printed()
    for (const s of ['key_1', 'CI runner', 'vk_ab12', 'gateway:use, traces:read', '2026-11-14', 'key_2', 'never']) {
      expect(out).toContain(s)
    }
  })

  it('--json prints the response', async () => {
    const body = { listProperty: 'data', rowCase: 'camel', data: [KEY] }
    fetchMock.mockReturnValue(reply(200, body))
    await runKeysList({ json: true })
    expect(JSON.parse(printed())).toEqual(body)
  })
})

describe('intutic keys create', () => {
  const CREATED = { ...KEY, key: 'vk_plaintext_once' }

  it('POSTs the label, scopes, expiry and service-account flag, and prints the key once', async () => {
    fetchMock.mockReturnValue(reply(201, CREATED))
    await runKeysCreate({ label: 'CI runner', scopes: 'gateway:use, traces:read', expiresInDays: '30', serviceAccount: true })
    expect(sent()).toEqual({
      url: `${BASE}/api/v1/keys`,
      method: 'POST',
      body: { label: 'CI runner', scopes: ['gateway:use', 'traces:read'], expiresInDays: 30, isServiceAccount: true },
    })
    expect(printed()).toContain('vk_plaintext_once')
    expect(printed()).toMatch(/shown once/i)
  })

  it('sends only the label without other flags, so the server defaults the scopes to *', async () => {
    fetchMock.mockReturnValue(reply(201, { ...CREATED, scopes: ['*'] }))
    await runKeysCreate({ label: 'laptop' })
    expect(sent().body).toEqual({ label: 'laptop' })
  })

  it('refuses a scope outside the registry, naming the valid ones, before any request', async () => {
    await expectFailure(() => runKeysCreate({ label: 'x', scopes: 'gateway:use,traces:admin' }), 'Unknown scope "traces:admin"')
    expect(printedError()).toContain('Valid scopes: *, gateway:use')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a non-positive --expires-in-days before any request', async () => {
    await expectFailure(() => runKeysCreate({ label: 'x', expiresInDays: '0' }), '--expires-in-days must be a positive whole number')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('intutic keys update', () => {
  it('PATCHes only the scopes', async () => {
    fetchMock.mockReturnValue(reply(200, KEY))
    await runKeysUpdate('key_1', { scopes: 'gateway:use,traces:read' })
    expect(sent()).toEqual({ url: `${BASE}/api/v1/keys/key_1`, method: 'PATCH', body: { scopes: ['gateway:use', 'traces:read'] } })
    expect(printed()).toContain('gateway:use, traces:read')
  })

  it('refuses an unknown scope before any request', async () => {
    await expectFailure(() => runKeysUpdate('key_1', { scopes: 'admin' }), 'Unknown scope "admin"')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an empty --scopes before any request', async () => {
    await expectFailure(() => runKeysUpdate('key_1', { scopes: ' , ' }), '--scopes')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("prints the server's refusal and exits 1", async () => {
    fetchMock.mockReturnValue(reply(403, { error: 'Forbidden', detail: 'Requires the OWNER or ADMIN role' }))
    await expectFailure(() => runKeysUpdate('key_1', { scopes: '*' }), 'Failed to update the scopes of key_1')
  })
})

describe('intutic keys revoke', () => {
  it('DELETEs the key', async () => {
    fetchMock.mockReturnValue(reply(200, { revoked: true }))
    await runKeysRevoke('key/1', {})
    expect(sent()).toMatchObject({ url: `${BASE}/api/v1/keys/key%2F1`, method: 'DELETE' })
    expect(printed()).toContain('key/1')
  })

  it('says so and exits 1 when there is no such live key', async () => {
    fetchMock.mockReturnValue(reply(404, { error: 'API key not found', code: 'E_NOT_FOUND' }))
    await expectFailure(() => runKeysRevoke('key_gone', {}), 'No live API key key_gone you can revoke')
  })

  it("prints the server's other refusals and exits 1", async () => {
    fetchMock.mockReturnValue(reply(503, { error: 'API key cache invalidation service is temporarily unavailable' }))
    await expectFailure(() => runKeysRevoke('key_1', {}), 'Failed to revoke API key key_1 (503)')
  })
})
