/**
 * `intutic credentials` — hits the right routes with the right bodies for
 * provisioning a workspace's own upstream provider keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import { runCredentialsList, runCredentialsModels, runCredentialsSet, runCredentialsUnset } from './credentials.js'

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

  it('set checks the saved credential against the provider and says what came back', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ provider: 'bedrock', routingLive: true, provisioned: true, lastFour: 'WXYZ', updatedAt: '2026-10-09T00:00:00Z' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ provider: 'bedrock', status: 'invalid', httpStatus: 403, detail: 'AWS Bedrock rejected the credential (HTTP 403)' }),
      })

    await runCredentialsSet('bedrock', { field: ['awsRegion=us-east-1', 'apiKey=bedrock-key-12345'] })

    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('https://api.test.invalid/api/v1/workspace/provider-credentials/bedrock/verify')
    expect(init.method).toBe('POST')
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('rejected the credential')
    expect(printed).not.toContain('bedrock-key-12345')
  })

  it('set hits PUT with multiple fields for a multi-field provider', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'azure_openai', routingLive: false, provisioned: true, lastFour: null, updatedAt: '2026-08-13T00:00:00Z' }),
    })

    await runCredentialsSet('azure_openai', {
      field: ['apiKey=sk-abc12345', 'endpoint=https://foo.openai.azure.com'],
    })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({
      apiKey: 'sk-abc12345',
      endpoint: 'https://foo.openai.azure.com',
    })
  })

  it('set reads a --field-file value from disk (a Vertex AI service-account key)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'vertex_ai', routingLive: true, provisioned: true, lastFour: null, updatedAt: '2026-10-09T00:00:00Z' }),
    })
    const dir = mkdtempSync(join(tmpdir(), 'intutic-cred-'))
    const keyFile = join(dir, 'sa.json')
    const doc = JSON.stringify({ type: 'service_account', client_email: 'sa@p.iam.gserviceaccount.com' }, null, 2)
    writeFileSync(keyFile, doc)

    await runCredentialsSet('vertex_ai', {
      field: ['projectId=proj-1'],
      fieldFile: [`serviceAccountJson=${keyFile}`],
    })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ projectId: 'proj-1', serviceAccountJson: doc })
  })

  it('set refuses a Bedrock credential with neither a key pair nor an API key', async () => {
    await expect(runCredentialsSet('bedrock', { field: ['awsRegion=us-east-1'] })).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('set refuses an Azure endpoint that is not an Azure resource', async () => {
    await expect(
      runCredentialsSet('azure_openai', { field: ['apiKey=sk-abc12345', 'endpoint=https://foo.example.com'] }),
    ).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ── LLD #70: registry pre-check hardening ──

  it('set refuses an unknown provider before any request is sent', async () => {
    await expect(runCredentialsSet('not-a-real-provider', { field: ['apiKey=sk-test-1234567890'] })).rejects.toThrow(
      'process.exit(1)',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('set refuses a field key the provider does not declare', async () => {
    await expect(
      runCredentialsSet('anthropic', { field: ['apiKey=sk-ant-1234567890', 'notARealField=x'] }),
    ).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('set refuses when a required field is missing', async () => {
    await expect(
      runCredentialsSet('azure_openai', { field: ['endpoint=https://foo.openai.azure.com'] }),
    ).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
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

  it('set says how many models the verified key can reach and where to list them', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ provider: 'openai', routingLive: true, provisioned: true, lastFour: 'wxyz', updatedAt: '2026-10-10T00:00:00Z' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ provider: 'openai', status: 'valid', httpStatus: 200, detail: 'OpenAI accepted the credential', models: ['gpt-4.1', 'gpt-4.1-mini', 'o3'] }),
      })

    await runCredentialsSet('openai', { field: ['apiKey=openai-test-wxyz'] })

    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('3 models')
    expect(printed).toContain('intutic credentials models openai')
  })

  it('set prints no model count when the verify answer lists none', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ provider: 'azure_openai', routingLive: true, provisioned: true, lastFour: 'wxyz', updatedAt: '2026-10-10T00:00:00Z' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ provider: 'azure_openai', status: 'valid', httpStatus: 200, detail: 'Azure OpenAI accepted the credential' }),
      })

    await runCredentialsSet('azure_openai', { field: ['apiKey=azure-test-wxyz', 'endpoint=https://foo.openai.azure.com'] })

    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).not.toContain('credentials models')
  })

  it('models hits GET .../provider-credentials/:provider/models and prints each model and when it was checked', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'anthropic', models: ['claude-haiku-4-5', 'claude-sonnet-5-5'], checkedAt: '2026-10-10T09:30:00Z' }),
    })

    await runCredentialsModels('anthropic', {})

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/workspace/provider-credentials/anthropic/models')
    expect(init.method).toBe('GET')
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('claude-haiku-4-5')
    expect(printed).toContain('claude-sonnet-5-5')
    expect(printed).toContain('2026-10-10T09:30:00Z')
  })

  it('models says none are discovered yet, and how to record them, when the list is null', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'mistral', models: null, checkedAt: null }),
    })

    await runCredentialsModels('mistral', {})

    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toMatch(/no models discovered/i)
    expect(printed).toContain('intutic credentials set mistral')
  })

  it('models --json prints the response as returned', async () => {
    const body = { provider: 'gemini', models: ['gemini-2.5-pro'], checkedAt: '2026-10-10T09:30:00Z' }
    fetchMock.mockResolvedValue({ ok: true, json: async () => body })

    await runCredentialsModels('gemini', { json: true })

    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual(body)
  })

  it('models refuses an unknown provider before any request is sent', async () => {
    await expect(runCredentialsModels('not-a-real-provider', {})).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
    const printed = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('Unknown provider "not-a-real-provider"')
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
