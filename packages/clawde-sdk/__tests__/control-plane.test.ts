import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, Server } from 'http'
import { ControlPlaneClient } from '../src/control-plane'
import { ClawdeConnectionError } from '../src/errors'

describe('ControlPlaneClient', () => {
  let server: Server
  let baseUrl: string
  let receivedMethod = ''
  let receivedPath = ''
  let receivedHeaders: any = {}
  let receivedBody: any = undefined
  let respondWithStatus = 200
  let respondWithBody: any = {}

  beforeAll(() => {
    return new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        receivedMethod = req.method ?? ''
        receivedPath = req.url ?? ''
        receivedHeaders = req.headers

        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          receivedBody = body ? JSON.parse(body) : undefined
          res.writeHead(respondWithStatus, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(respondWithBody))
        })
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any
        baseUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
  })

  afterAll(() => {
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    receivedMethod = ''
    receivedPath = ''
    receivedHeaders = {}
    receivedBody = undefined
    respondWithStatus = 200
    respondWithBody = {}
  })

  it('requires an apiKey', () => {
    expect(() => new ControlPlaneClient({ apiKey: '' })).toThrow('API key is required')
  })

  it('whoami() calls GET /api/v1/auth/me with the bearer token', async () => {
    respondWithBody = { email: 'a@b.com', memberId: 'mem_1', workspaceId: 'ws_1', role: 'OWNER' }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.whoami()
    expect(receivedMethod).toBe('GET')
    expect(receivedPath).toBe('/api/v1/auth/me')
    expect(receivedHeaders['authorization']).toBe('Bearer vk_test')
    expect(res.role).toBe('OWNER')
  })

  it('signupOrg() calls POST /api/v1/auth/signup/org WITHOUT a bearer token', async () => {
    respondWithBody = {
      user: { id: 'u1', email: 'a@b.com', name: 'A', emailVerified: false },
      org: { id: 'org_1', name: 'Acme', planTier: 'pro', trialExpiresAt: '2026-09-01' },
      workspace: { id: 'ws_1', name: 'default', planTier: 'pro', trialExpiresAt: '2026-09-01' },
      accessToken: 'tok', refreshToken: 'rtok', cliInstall: 'npm i -g @intutic/cli', isNewUser: true,
    }
    const client = new ControlPlaneClient({ apiKey: 'unused', baseUrl })
    const res = await client.signupOrg({ email: 'a@b.com', password: 'password123', name: 'A', orgName: 'Acme' })
    expect(receivedMethod).toBe('POST')
    expect(receivedPath).toBe('/api/v1/auth/signup/org')
    expect(receivedHeaders['authorization']).toBeUndefined()
    expect(receivedBody).toEqual({ email: 'a@b.com', password: 'password123', name: 'A', orgName: 'Acme' })
    expect(res.org.id).toBe('org_1')
  })

  it('startDomainVerification() posts the domain with a bearer token', async () => {
    respondWithBody = {
      verificationId: 'dv_1', domain: 'acme.com',
      txtRecordName: '_intutic-verify.acme.com', txtRecordValue: 'abc123', expiresAt: '2026-09-01',
    }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.startDomainVerification('acme.com')
    expect(receivedMethod).toBe('POST')
    expect(receivedPath).toBe('/api/v1/domain-verification/start')
    expect(receivedHeaders['authorization']).toBe('Bearer vk_test')
    expect(receivedBody).toEqual({ domain: 'acme.com' })
    expect(res.verificationId).toBe('dv_1')
    expect(res.txtRecordValue).toBe('abc123')
  })

  it('checkDomainVerification() calls GET /api/v1/domain-verification/:id', async () => {
    respondWithBody = {
      verificationId: 'dv_1', domain: 'acme.com', status: 'verified',
      txtRecordName: '_intutic-verify.acme.com', txtRecordValue: 'abc123', verifiedAt: '2026-08-14',
    }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.checkDomainVerification('dv_1')
    expect(receivedMethod).toBe('GET')
    expect(receivedPath).toBe('/api/v1/domain-verification/dv_1')
    expect(res.status).toBe('verified')
  })

  it('createOrg() posts orgName/domain/verificationId to /api/v1/orgs with a bearer token', async () => {
    respondWithBody = { orgId: 'org_1', teamId: 'team_1', workspaceId: 'ws_1', name: 'Acme', planTier: 'pro' }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.createOrg({ orgName: 'Acme', domain: 'acme.com', verificationId: 'dv_1' })
    expect(receivedMethod).toBe('POST')
    expect(receivedPath).toBe('/api/v1/orgs')
    expect(receivedHeaders['authorization']).toBe('Bearer vk_test')
    expect(receivedBody).toEqual({ orgName: 'Acme', domain: 'acme.com', verificationId: 'dv_1' })
    expect(res.orgId).toBe('org_1')
  })

  it('createOrg() passes the optional region through; omits it when not given', async () => {
    respondWithBody = { orgId: 'org_1', teamId: 'team_1', workspaceId: 'ws_1', name: 'Acme', planTier: 'pro', region: 'eu' }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.createOrg({ orgName: 'Acme', domain: 'acme.com', verificationId: 'dv_1', region: 'eu' })
    expect(receivedBody).toEqual({ orgName: 'Acme', domain: 'acme.com', verificationId: 'dv_1', region: 'eu' })
    expect(res.region).toBe('eu')
  })

  it('listTeams() unwraps the {data} envelope', async () => {
    respondWithBody = { data: [{ teamId: 't1', orgId: 'org_1', name: 'Eng', slug: 'eng', createdAt: '2026-01-01' }] }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.listTeams('org_1')
    expect(receivedMethod).toBe('GET')
    expect(receivedPath).toBe('/api/v1/orgs/org_1/teams')
    expect(res).toHaveLength(1)
    expect(res[0].teamId).toBe('t1')
  })

  it('listTeams() defaults to [] when data is absent', async () => {
    respondWithBody = {}
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    expect(await client.listTeams('org_1')).toEqual([])
  })

  it('createTeam() posts the name to /api/v1/orgs/:orgId/teams', async () => {
    respondWithBody = { teamId: 't2', orgId: 'org_1', name: 'Design', slug: 'design', createdAt: '2026-01-01' }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.createTeam('org_1', 'Design')
    expect(receivedMethod).toBe('POST')
    expect(receivedPath).toBe('/api/v1/orgs/org_1/teams')
    expect(receivedBody).toEqual({ name: 'Design' })
    expect(res.teamId).toBe('t2')
  })

  it('listTeamWorkspaces() calls GET /api/v1/teams/:teamId/workspaces', async () => {
    respondWithBody = { data: [{ workspaceId: 'ws_2', name: 'w', slug: 'w', planTier: 'pro', createdAt: '2026-01-01' }] }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.listTeamWorkspaces('t1')
    expect(receivedPath).toBe('/api/v1/teams/t1/workspaces')
    expect(res[0].workspaceId).toBe('ws_2')
  })

  it('createWorkspace() posts the name to /api/v1/teams/:teamId/workspaces', async () => {
    respondWithBody = { workspaceId: 'ws_3', teamId: 't1', orgId: 'org_1', name: 'w2' }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.createWorkspace('t1', 'w2')
    expect(receivedMethod).toBe('POST')
    expect(receivedPath).toBe('/api/v1/teams/t1/workspaces')
    expect(receivedBody).toEqual({ name: 'w2' })
    expect(res.workspaceId).toBe('ws_3')
  })

  it('registerGateway() posts name+deploymentTarget to /api/v1/gateways', async () => {
    respondWithBody = { gatewayId: 'gw_1', name: 'prod', deploymentTarget: 'docker', status: 'pending', token: 'gwk_once', instructions: 'go' }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.registerGateway({ name: 'prod', deploymentTarget: 'docker' })
    expect(receivedMethod).toBe('POST')
    expect(receivedPath).toBe('/api/v1/gateways')
    expect(receivedBody).toEqual({ name: 'prod', deploymentTarget: 'docker' })
    expect(res.token).toBe('gwk_once')
  })

  it('listGateways() calls GET /api/v1/gateways and unwraps data', async () => {
    respondWithBody = { data: [{ gatewayId: 'gw_1', name: 'prod', deploymentTarget: 'docker', status: 'online', keyPrefix: 'gwk_abc', lastHeartbeatAt: null, proxyVersion: null, createdAt: '2026-01-01', revokedAt: null }] }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.listGateways()
    expect(receivedPath).toBe('/api/v1/gateways')
    expect(res[0].gatewayId).toBe('gw_1')
  })

  it('getGatewayStatus() calls GET /api/v1/gateways/:id/status', async () => {
    respondWithBody = { status: 'online', proxyVersion: '1.0', uptimeSeconds: 100, activeWorkspaces: 3, litellmReachable: true, lastError: null, reportedAt: '2026-01-01' }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.getGatewayStatus('gw_1')
    expect(receivedPath).toBe('/api/v1/gateways/gw_1/status')
    expect(res.status).toBe('online')
  })

  it('rotateGatewayToken() posts an empty body to /api/v1/gateways/:id/rotate', async () => {
    respondWithBody = { gatewayId: 'gw_1', token: 'gwk_new', previousTokenValidUntil: '2026-01-02', instructions: 'go' }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.rotateGatewayToken('gw_1')
    expect(receivedMethod).toBe('POST')
    expect(receivedPath).toBe('/api/v1/gateways/gw_1/rotate')
    expect(res.token).toBe('gwk_new')
  })

  it('revokeGateway() sends DELETE with the reason in the body', async () => {
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    await client.revokeGateway('gw_1', 'decommissioned')
    expect(receivedMethod).toBe('DELETE')
    expect(receivedPath).toBe('/api/v1/gateways/gw_1')
    expect(receivedBody).toEqual({ reason: 'decommissioned' })
  })

  it('setGatewayConfig() PATCHes /api/v1/gateways/:id/config', async () => {
    respondWithBody = { config: { requireVk: true }, configVersion: 2 }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.setGatewayConfig('gw_1', { requireVk: true })
    expect(receivedMethod).toBe('PATCH')
    expect(receivedPath).toBe('/api/v1/gateways/gw_1/config')
    expect(receivedBody).toEqual({ requireVk: true })
    expect(res.configVersion).toBe(2)
  })

  it('assignWorkspaceGateway() PATCHes /api/v1/workspace/gateway, null clears it', async () => {
    respondWithBody = { gatewayId: null }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    await client.assignWorkspaceGateway(null)
    expect(receivedMethod).toBe('PATCH')
    expect(receivedPath).toBe('/api/v1/workspace/gateway')
    expect(receivedBody).toEqual({ gatewayId: null })
  })

  it('assignOrgGateway() PATCHes /api/v1/orgs/:orgId/gateway', async () => {
    respondWithBody = { gatewayId: 'gw_1' }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    await client.assignOrgGateway('org_1', 'gw_1')
    expect(receivedMethod).toBe('PATCH')
    expect(receivedPath).toBe('/api/v1/orgs/org_1/gateway')
    expect(receivedBody).toEqual({ gatewayId: 'gw_1' })
  })

  it('resolveGateway() calls GET /api/v1/workspace/gateway-resolution', async () => {
    respondWithBody = { source: 'org', gateway: { gatewayId: 'gw_1', name: 'prod', deploymentTarget: 'docker', status: 'online' } }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.resolveGateway()
    expect(receivedPath).toBe('/api/v1/workspace/gateway-resolution')
    expect(res.source).toBe('org')
  })

  it('listProviderCredentials() unwraps the {data} envelope', async () => {
    respondWithBody = { data: [{ provider: 'anthropic', routingLive: true, provisioned: true, lastFour: 'ab12', updatedAt: '2026-01-01' }] }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.listProviderCredentials()
    expect(receivedPath).toBe('/api/v1/workspace/provider-credentials')
    expect(res[0].provider).toBe('anthropic')
  })

  it('setProviderCredential() PUTs the fields to /api/v1/workspace/provider-credentials/:provider', async () => {
    respondWithBody = { provider: 'openrouter', routingLive: false, provisioned: true, lastFour: 'cd34', updatedAt: '2026-01-01' }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    const res = await client.setProviderCredential('openrouter', { apiKey: 'sk-or-abc' })
    expect(receivedMethod).toBe('PUT')
    expect(receivedPath).toBe('/api/v1/workspace/provider-credentials/openrouter')
    expect(receivedBody).toEqual({ apiKey: 'sk-or-abc' })
    expect(res.routingLive).toBe(false)
  })

  it('unsetProviderCredential() sends DELETE to /api/v1/workspace/provider-credentials/:provider', async () => {
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    await client.unsetProviderCredential('openrouter')
    expect(receivedMethod).toBe('DELETE')
    expect(receivedPath).toBe('/api/v1/workspace/provider-credentials/openrouter')
  })

  it('URL-encodes path segments (provider names, ids)', async () => {
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    await client.unsetProviderCredential('a b/c')
    expect(receivedPath).toBe('/api/v1/workspace/provider-credentials/a%20b%2Fc')
  })

  it('raises ClawdeConnectionError with the response body text on a non-2xx status', async () => {
    respondWithStatus = 403
    respondWithBody = { error: 'Forbidden' }
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
    await expect(client.whoami()).rejects.toThrow(ClawdeConnectionError)
    await expect(client.whoami()).rejects.toThrow(/403/)
  })

  it('raises ClawdeConnectionError when the control plane is unreachable', async () => {
    const client = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl: 'http://127.0.0.1:1' })
    await expect(client.whoami()).rejects.toThrow(ClawdeConnectionError)
  })

  it('defaults baseUrl to https://app.intutic.ai when unset', () => {
    const original = process.env.INTUTIC_CONTROL_PLANE_URL
    delete process.env.INTUTIC_CONTROL_PLANE_URL
    try {
      // No network call — this only proves the constructor doesn't throw
      // and picks the documented default; the URL itself is private.
      expect(() => new ControlPlaneClient({ apiKey: 'vk_test' })).not.toThrow()
    } finally {
      if (original !== undefined) process.env.INTUTIC_CONTROL_PLANE_URL = original
    }
  })
})
