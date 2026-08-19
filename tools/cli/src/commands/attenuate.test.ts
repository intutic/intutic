/**
 * `intutic attenuate` / `intutic attenuate chain` — the mint/inspect half of
 * DCT token attenuation. These tests assert the right routes and bodies are
 * hit, `--caps` is split/trimmed client-side, and failures (including the
 * server's cap-violation 403) exit non-zero with the error surfaced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => ({ devMode: false })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import { runAttenuate, runAttenuateChain } from './attenuate.js'

describe('runAttenuate', () => {
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

  it('posts to /api/v1/attenuate with parentKeyId + split/trimmed requestedCaps', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        childKey: 'vk_child123',
        childKeyId: 'vk_child_id',
        attenuationChainId: 'att_1',
        grantedCaps: ['read', 'write'],
        expiresAt: '2026-08-21T00:00:00.000Z',
      }),
    })

    await runAttenuate({ parentKey: 'vk_parent', caps: ' read , write ' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/attenuate')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      parentKeyId: 'vk_parent',
      requestedCaps: ['read', 'write'],
    })
    expect(init.headers.Authorization).toBe('Bearer vk_test_key')

    const printed = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')
    expect(printed).toContain('vk_child123')
    expect(printed).toContain('att_1')
  })

  it('includes ttlSeconds only when --ttl is passed', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        childKey: 'vk_child',
        childKeyId: 'id',
        attenuationChainId: 'att_2',
        grantedCaps: ['read'],
        expiresAt: '2026-08-21T00:00:00.000Z',
      }),
    })

    await runAttenuate({ parentKey: 'vk_parent', caps: 'read', ttl: '3600' })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({
      parentKeyId: 'vk_parent',
      requestedCaps: ['read'],
      ttlSeconds: 3600,
    })
  })

  it('exits 1 without calling the API when --parent-key is missing', async () => {
    await expect(runAttenuate({ caps: 'read' })).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 1 without calling the API when --caps is missing or empty', async () => {
    await expect(runAttenuate({ parentKey: 'vk_parent', caps: '' })).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 1 when --ttl is not a positive number', async () => {
    await expect(
      runAttenuate({ parentKey: 'vk_parent', caps: 'read', ttl: 'not-a-number' }),
    ).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a cap-violation 403 and exits non-zero rather than swallowing it', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Requested capabilities [admin] are not available in parent key',
    })

    await expect(
      runAttenuate({ parentKey: 'vk_parent', caps: 'admin' }),
    ).rejects.toThrow('process.exit(1)')

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy).toHaveBeenCalled()
  })
})

describe('runAttenuateChain', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let logSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errSpy: any

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

  it('GETs /api/v1/attenuate/chain/:chainId and prints the lineage', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        chain: [
          {
            chainId: 'att_1',
            parentKeyId: 'vk_parent',
            childKeyId: 'vk_child',
            workspaceId: 'ws_test',
            grantedCaps: ['read'],
            expiresAt: '2026-08-21T00:00:00.000Z',
            createdAt: '2026-08-20T00:00:00.000Z',
          },
        ],
      }),
    })

    await runAttenuateChain('att_1', {})

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/attenuate/chain/att_1')
    expect(init.method).toBe('GET')

    const printed = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')
    expect(printed).toContain('vk_parent')
    expect(printed).toContain('vk_child')
  })

  it('reports no lineage found for an empty chain, without throwing', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ chain: [] }) })

    await runAttenuateChain('att_missing', {})

    const printed = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')
    expect(printed).toMatch(/no lineage/i)
  })

  it('exits 1 on a 404', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Attenuation chain att_missing not found',
    })

    await expect(runAttenuateChain('att_missing', {})).rejects.toThrow('process.exit(1)')
    expect(errSpy).toHaveBeenCalled()
  })
})
