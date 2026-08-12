/**
 * `intutic team` — hits the right routes with the right bodies for team
 * and team-workspace management.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import { runTeamList, runTeamCreate, runTeamWorkspaces, runTeamCreateWorkspace } from './team.js'

describe('intutic team', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spyOn's inferred type narrows to the
  // mocked implementation's signature, which is incompatible with a pre-declared generic annotation.
  let exitSpy: any
  let errSpy: any

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('list hits GET /api/v1/orgs/:orgId/teams', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) })

    await runTeamList({ org: 'org_1' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/orgs/org_1/teams')
    expect(init.method).toBe('GET')
  })

  it('list refuses with no --org', async () => {
    await expect(runTeamList({})).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('create hits POST /api/v1/orgs/:orgId/teams with the name', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ teamId: 'tm_1', orgId: 'org_1', name: 'Platform' }),
    })

    await runTeamCreate({ org: 'org_1', name: 'Platform' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/orgs/org_1/teams')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ name: 'Platform' })
  })

  it('workspaces hits GET /api/v1/teams/:teamId/workspaces', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) })

    await runTeamWorkspaces('tm_1', {})

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/teams/tm_1/workspaces')
    expect(init.method).toBe('GET')
  })

  it('create-workspace hits POST /api/v1/teams/:teamId/workspaces with the name', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ workspaceId: 'wk_2', teamId: 'tm_1', orgId: 'org_1', name: 'Second Workspace' }),
    })

    await runTeamCreateWorkspace('tm_1', { name: 'Second Workspace' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/teams/tm_1/workspaces')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ name: 'Second Workspace' })
  })

  it('create-workspace refuses with no --name', async () => {
    await expect(runTeamCreateWorkspace('tm_1', {})).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits non-zero and reports the failure on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => 'Team not found' })

    await expect(runTeamWorkspaces('tm_missing', {})).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy).toHaveBeenCalled()
  })
})
