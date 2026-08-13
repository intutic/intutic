/**
 * `intutic gateway` — hits the right routes with the right bodies, and
 * refuses to proceed on missing required flags rather than sending a
 * malformed request the server would 400 on anyway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import {
  runGatewayRegister,
  runGatewayList,
  runGatewayStatus,
  runGatewayRotate,
  runGatewayRevoke,
  runGatewayConfigSet,
  runGatewayAssign,
  runGatewayResolve,
} from './gateway.js'

describe('intutic gateway', () => {
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

  it('register hits POST /api/v1/gateways with name and deploymentTarget', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        gatewayId: 'gw_abc',
        name: 'Prod Gateway',
        deploymentTarget: 'docker',
        status: 'pending',
        token: 'gwk_secret',
        instructions: 'Set this as INTUTIC_GATEWAY_TOKEN.',
      }),
    })

    await runGatewayRegister({ name: 'Prod Gateway', target: 'docker' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/gateways')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ name: 'Prod Gateway', deploymentTarget: 'docker' })
    expect(init.headers.Authorization).toBe('Bearer vk_test_key')

    // The token must reach the terminal — this is the only place it is ever shown.
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('gwk_secret')
  })

  it('register refuses an invalid --target before calling the API', async () => {
    await expect(
      runGatewayRegister({ name: 'x', target: 'not-a-real-target' }),
    ).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
  })

  it('list hits GET /api/v1/gateways', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    })

    await runGatewayList({})

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/gateways')
    expect(init.method).toBe('GET')
  })

  it('status hits GET /api/v1/gateways/:id/status', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'online',
        proxyVersion: '1.10.0',
        uptimeSeconds: 3600,
        activeWorkspaces: 2,
        litellmReachable: null,
        lastError: null,
        reportedAt: '2026-08-13T00:00:00Z',
      }),
    })

    await runGatewayStatus('gw_abc', {})

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/gateways/gw_abc/status')
  })

  it('rotate hits POST /api/v1/gateways/:id/rotate with an empty body and prints the new token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        gatewayId: 'gw_abc',
        token: 'gwk_new_secret',
        previousTokenValidUntil: '2026-08-14T00:00:00Z',
        instructions: 'Restart the daemon.',
      }),
    })

    await runGatewayRotate('gw_abc', {})

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/gateways/gw_abc/rotate')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({})

    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('gwk_new_secret')
  })

  it('revoke hits DELETE /api/v1/gateways/:id with the reason', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ revoked: true }),
    })

    await runGatewayRevoke('gw_abc', { reason: 'decommissioned' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/gateways/gw_abc')
    expect(init.method).toBe('DELETE')
    expect(JSON.parse(init.body)).toEqual({ reason: 'decommissioned' })
  })

  it('config set hits PATCH /api/v1/gateways/:id/config with only the provided booleans', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ config: { requireProvisionedKey: true }, configVersion: 2 }),
    })

    await runGatewayConfigSet('gw_abc', { requireProvisionedKey: 'true' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/gateways/gw_abc/config')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ requireProvisionedKey: true })
  })

  it('config set refuses when neither flag is provided', async () => {
    await expect(runGatewayConfigSet('gw_abc', {})).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('config set refuses a non-boolean value', async () => {
    await expect(
      runGatewayConfigSet('gw_abc', { requireVk: 'yes' }),
    ).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits non-zero and reports the failure on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Gateway not found',
    })

    await expect(runGatewayStatus('gw_missing', {})).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy).toHaveBeenCalled()
  })

  it('assign hits PATCH /api/v1/workspace/gateway with the gatewayId', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ workspaceId: 'ws_test', gatewayId: 'gw_abc' }),
    })

    await runGatewayAssign({ gateway: 'gw_abc' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/workspace/gateway')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ gatewayId: 'gw_abc' })
  })

  it('assign --org hits PATCH /api/v1/orgs/:orgId/gateway instead', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ orgId: 'org_1', gatewayId: 'gw_abc' }),
    })

    await runGatewayAssign({ gateway: 'gw_abc', org: 'org_1' })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/orgs/org_1/gateway')
  })

  it('assign --clear sends gatewayId: null', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ workspaceId: 'ws_test', gatewayId: null }),
    })

    await runGatewayAssign({ clear: true })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ gatewayId: null })
  })

  it('assign refuses with neither --gateway nor --clear', async () => {
    await expect(runGatewayAssign({})).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('assign refuses with both --gateway and --clear', async () => {
    await expect(runGatewayAssign({ gateway: 'gw_abc', clear: true })).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolve hits GET /api/v1/workspace/gateway-resolution', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ source: 'default', gateway: null }),
    })

    await runGatewayResolve({})

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/workspace/gateway-resolution')
    expect(init.method).toBe('GET')
  })

  it('resolve reports a stale assignment distinctly from no assignment', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ source: 'workspace', gateway: null, staleAssignment: 'gw_gone' }),
    })

    await runGatewayResolve({})

    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('gw_gone')
  })
})
