/**
 * `intutic org create` — starts DNS domain verification, polls until
 * verified, creates the org via POST /api/v1/orgs, and switches the CLI's
 * stored session into the new workspace.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const loadCredentialsMock = vi.fn()
const saveCredentialsMock = vi.fn()
vi.mock('../config/store.js', () => ({
  loadCredentials: (...args: unknown[]) => loadCredentialsMock(...args),
  saveCredentials: (...args: unknown[]) => saveCredentialsMock(...args),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

// One "press Enter" answer per queued prompt; defaults to "" (proceed/confirm) forever once exhausted.
let promptAnswers: string[] = []
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => {
      cb(promptAnswers.length > 0 ? promptAnswers.shift()! : '')
    },
    close: () => {},
  }),
}))

import { runOrgCreate } from './org.js'

const CREDS = {
  apiKey: 'jwt_existing',
  workspaceId: 'wk_old',
  controlPlaneUrl: 'https://api.test.invalid',
  email: 'jane@acme.test',
  storedAt: '2026-08-01T00:00:00Z',
}

describe('intutic org create', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spyOn's inferred type narrows to the
  // mocked implementation's signature, which is incompatible with a pre-declared generic annotation.
  let exitSpy: any
  let logSpy: any
  let errSpy: any

  beforeEach(() => {
    promptAnswers = []
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    loadCredentialsMock.mockReset()
    loadCredentialsMock.mockResolvedValue(CREDS)
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

  function mockRoute(byUrl: Record<string, { status?: number; body: unknown }>) {
    fetchMock.mockImplementation((url: string) => {
      const match = Object.entries(byUrl).find(([key]) => url.includes(key))
      if (!match) throw new Error(`Unexpected fetch to ${url}`)
      const { status = 200, body } = match[1]
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      })
    })
  }

  it('exits if not authenticated', async () => {
    loadCredentialsMock.mockResolvedValue(null)
    await expect(runOrgCreate({ orgName: 'Acme', domain: 'acme.com' })).rejects.toThrow('process.exit(1)')
    expect(errSpy).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('starts verification, polls once (pending then verified), creates the org, and switches session', async () => {
    let checkCount = 0
    fetchMock.mockImplementation((url: string, init?: any) => {
      if (url.includes('/api/v1/domain-verification/start')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            verificationId: 'dv_1',
            domain: 'acme.com',
            txtRecordName: '_intutic-verify.acme.com',
            txtRecordValue: 'abc123',
            expiresAt: '2026-09-01T00:00:00Z',
          }),
        })
      }
      if (url.includes('/api/v1/domain-verification/dv_1')) {
        checkCount++
        const status = checkCount === 1 ? 'pending' : 'verified'
        return Promise.resolve({
          ok: true,
          json: async () => ({
            verificationId: 'dv_1',
            domain: 'acme.com',
            status,
            txtRecordName: '_intutic-verify.acme.com',
            txtRecordValue: 'abc123',
            verifiedAt: status === 'verified' ? '2026-08-14T00:00:00Z' : null,
          }),
        })
      }
      if (url.endsWith('/api/v1/orgs')) {
        expect(init.method).toBe('POST')
        expect(JSON.parse(init.body)).toEqual({
          orgName: 'Acme',
          domain: 'acme.com',
          verificationId: 'dv_1',
        })
        return Promise.resolve({
          ok: true,
          json: async () => ({ orgId: 'org_1', teamId: 'team_1', workspaceId: 'wk_new', name: 'Acme', planTier: 'pro' }),
        })
      }
      if (url.endsWith('/api/v1/auth/session')) {
        expect(init.headers['X-Workspace-Id']).toBe('wk_new')
        return Promise.resolve({
          ok: true,
          json: async () => ({ memberId: 'mbr_1', workspaceId: 'wk_new', email: 'jane@acme.test', role: 'OWNER', refreshToken: 'refresh_new' }),
        })
      }
      if (url.endsWith('/api/v1/auth/refresh')) {
        expect(JSON.parse(init.body)).toEqual({ refreshToken: 'refresh_new' })
        return Promise.resolve({
          ok: true,
          json: async () => ({ accessToken: 'jwt_new', refreshToken: 'refresh_new_2', expiresIn: 900 }),
        })
      }
      throw new Error(`Unexpected fetch to ${url}`)
    })

    // Two prompts consumed before verified: press Enter for check #1 (pending), press Enter for check #2 (verified).
    promptAnswers = ['', '']

    await runOrgCreate({ orgName: 'Acme', domain: 'acme.com' })

    expect(checkCount).toBe(2)
    expect(saveCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'jwt_new',
        workspaceId: 'wk_new',
        controlPlaneUrl: 'https://api.test.invalid',
        email: 'jane@acme.test',
      }),
    )
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('org_1')
  })

  it('aborts without creating anything when the user types "q" at the check prompt', async () => {
    mockRoute({
      '/api/v1/domain-verification/start': {
        body: {
          verificationId: 'dv_1', domain: 'acme.com',
          txtRecordName: '_intutic-verify.acme.com', txtRecordValue: 'abc123', expiresAt: '2026-09-01',
        },
      },
    })
    promptAnswers = ['q']

    await expect(runOrgCreate({ orgName: 'Acme', domain: 'acme.com' })).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/v1/orgs'), expect.anything())
    expect(saveCredentialsMock).not.toHaveBeenCalled()
  })

  it('exits when the verification expires', async () => {
    mockRoute({
      '/api/v1/domain-verification/start': {
        body: {
          verificationId: 'dv_1', domain: 'acme.com',
          txtRecordName: '_intutic-verify.acme.com', txtRecordValue: 'abc123', expiresAt: '2026-09-01',
        },
      },
      '/api/v1/domain-verification/dv_1': {
        body: {
          verificationId: 'dv_1', domain: 'acme.com', status: 'expired',
          txtRecordName: '_intutic-verify.acme.com', txtRecordValue: 'abc123', verifiedAt: null,
        },
      },
    })
    promptAnswers = ['']

    await expect(runOrgCreate({ orgName: 'Acme', domain: 'acme.com' })).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(saveCredentialsMock).not.toHaveBeenCalled()
  })

  it('exits non-zero and reports the failure when org creation itself fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/v1/domain-verification/start')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            verificationId: 'dv_1', domain: 'acme.com',
            txtRecordName: '_intutic-verify.acme.com', txtRecordValue: 'abc123', expiresAt: '2026-09-01',
          }),
        })
      }
      if (url.includes('/api/v1/domain-verification/dv_1')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            verificationId: 'dv_1', domain: 'acme.com', status: 'verified',
            txtRecordName: '_intutic-verify.acme.com', txtRecordValue: 'abc123', verifiedAt: '2026-08-14T00:00:00Z',
          }),
        })
      }
      if (url.endsWith('/api/v1/orgs')) {
        return Promise.resolve({ ok: false, status: 403, text: async () => 'Domain verification was already used', json: async () => ({ error: 'Domain verification was already used' }) })
      }
      throw new Error(`Unexpected fetch to ${url}`)
    })
    promptAnswers = ['']

    await expect(runOrgCreate({ orgName: 'Acme', domain: 'acme.com' })).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy).toHaveBeenCalled()
    expect(saveCredentialsMock).not.toHaveBeenCalled()
  })
})
