/**
 * `intutic credentials` — hits the right routes with the right bodies for
 * provisioning a workspace's own upstream provider keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import { runCredentialsList, runCredentialsSet, runCredentialsUnset } from './credentials.js'

describe('intutic credentials', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spyOn's inferred type narrows to the
  // mocked implementation's signature, which is incompatible with a pre-declared generic annotation.
  let exitSpy: any
  let logSpy: any
  let errSpy: any

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

  it('list hits GET /api/v1/workspace/provider-credentials', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ provider: 'anthropic', routingLive: true, provisioned: false, lastFour: null, updatedAt: null }] }),
    })

    await runCredentialsList({})

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/workspace/provider-credentials')
    expect(init.method).toBe('GET')
  })

  it('set hits PUT .../provider-credentials/:provider with a single field', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'anthropic', routingLive: true, provisioned: true, lastFour: 'wxyz', updatedAt: '2026-08-13T00:00:00Z' }),
    })

    await runCredentialsSet('anthropic', { field: ['apiKey=sk-ant-abcwxyz'] })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/workspace/provider-credentials/anthropic')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ apiKey: 'sk-ant-abcwxyz' })
  })

  it('set hits PUT with multiple fields for a multi-field provider', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'azure_openai', routingLive: false, provisioned: true, lastFour: null, updatedAt: '2026-08-13T00:00:00Z' }),
    })

    await runCredentialsSet('azure_openai', {
      field: ['apiKey=sk-abc12345', 'endpoint=https://foo.openai.azure.com', 'deployment=gpt4'],
    })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({
      apiKey: 'sk-abc12345',
      endpoint: 'https://foo.openai.azure.com',
      deployment: 'gpt4',
    })
  })

  it('set warns when the provider is not yet routable', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'cohere', routingLive: false, provisioned: true, lastFour: 'wxyz', updatedAt: null }),
    })

    await runCredentialsSet('cohere', { field: ['apiKey=abcdwxyz'] })

    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toMatch(/not yet routable/i)
  })

  it('set refuses with no --field flags', async () => {
    await expect(runCredentialsSet('anthropic', {})).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('set refuses a field not in key=value form', async () => {
    await expect(
      runCredentialsSet('anthropic', { field: ['not-a-kv-pair'] }),
    ).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('unset hits DELETE .../provider-credentials/:provider', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'anthropic', routingLive: true, provisioned: false }),
    })

    await runCredentialsUnset('anthropic', {})

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/workspace/provider-credentials/anthropic')
    expect(init.method).toBe('DELETE')
  })

  it('exits non-zero and reports the failure on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    })

    await expect(runCredentialsSet('anthropic', { field: ['apiKey=sk-ant-abcwxyz'] })).rejects.toThrow(
      'process.exit(1)',
    )
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy).toHaveBeenCalled()
  })
})
