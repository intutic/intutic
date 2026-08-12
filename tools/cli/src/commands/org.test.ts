/**
 * `intutic org signup` — hits POST /api/v1/auth/signup/org with the right
 * body and persists credentials from the response, same as `login`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const saveCredentialsMock = vi.fn()
vi.mock('../config/store.js', () => ({
  saveCredentials: (...args: unknown[]) => saveCredentialsMock(...args),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import { runOrgSignup } from './org.js'

describe('intutic org signup', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spyOn's inferred type narrows to the
  // mocked implementation's signature, which is incompatible with a pre-declared generic annotation.
  let exitSpy: any
  let logSpy: any
  let errSpy: any

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    saveCredentialsMock.mockReset()
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

  it('hits POST /api/v1/auth/signup/org with email/password/name/orgName and saves credentials', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        user: { id: 'usr_1', email: 'jane@acme.test', name: 'Jane', emailVerified: false },
        org: { id: 'org_1', name: 'Acme', planTier: 'pro', trialExpiresAt: '2026-09-12T00:00:00Z' },
        workspace: { id: 'wk_1', name: 'Acme Default', planTier: 'pro', trialExpiresAt: '2026-09-12T00:00:00Z' },
        accessToken: 'jwt_abc',
        refreshToken: 'refresh_abc',
        cliInstall: 'intutic login',
        isNewUser: true,
      }),
    })

    await runOrgSignup({
      email: 'jane@acme.test',
      password: 'supersecret',
      name: 'Jane',
      orgName: 'Acme',
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/auth/signup/org')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      email: 'jane@acme.test',
      password: 'supersecret',
      name: 'Jane',
      orgName: 'Acme',
    })

    expect(saveCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'jwt_abc',
        workspaceId: 'wk_1',
        controlPlaneUrl: 'https://api.test.invalid',
        email: 'jane@acme.test',
      }),
    )

    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('org_1')
  })

  it('refuses a password under 8 characters before calling the API', async () => {
    await expect(
      runOrgSignup({ email: 'a@b.com', password: 'short', name: 'A', orgName: 'B' }),
    ).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(saveCredentialsMock).not.toHaveBeenCalled()
  })

  it('exits non-zero and reports the failure on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'Validation failed',
    })

    await expect(
      runOrgSignup({ email: 'a@b.com', password: 'supersecret', name: 'A', orgName: 'B' }),
    ).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy).toHaveBeenCalled()
    expect(saveCredentialsMock).not.toHaveBeenCalled()
  })
})
