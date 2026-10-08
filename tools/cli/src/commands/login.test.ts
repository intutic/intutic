/**
 * `intutic login --control-plane-url` must log in there AND save the URL with
 * the credentials, so every later command talks to the same control plane.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { saveCredentials, createApiClient } = vi.hoisted(() => ({
  saveCredentials: vi.fn(async (_creds: unknown) => {}),
  createApiClient: vi.fn((_url: string, _key: string) => ({
    getMe: async () => ({ email: 'dev@example.com', memberId: 'mem_1', workspaceId: 'wk_alpha', role: 'OWNER' }),
  })),
}))

vi.mock('../config/store.js', () => ({ saveCredentials }))
vi.mock('../lib/api.js', () => ({ createApiClient }))

import { runLogin } from './login.js'

describe('runLogin --control-plane-url', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    saveCredentials.mockClear()
    createApiClient.mockClear()
  })

  it('validates the key against that control plane and saves it with the credentials', async () => {
    await runLogin({ apiKey: 'vk_test_key', controlPlaneUrl: 'https://intutic.internal.example/' })

    expect(createApiClient).toHaveBeenCalledWith('https://intutic.internal.example', 'vk_test_key')
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ controlPlaneUrl: 'https://intutic.internal.example', workspaceId: 'wk_alpha' }),
    )
  })

  it('refuses a value that is not an http(s) URL, before any request', async () => {
    await expect(runLogin({ apiKey: 'vk_test_key', controlPlaneUrl: 'intutic.internal.example' })).rejects.toThrow('process.exit(1)')
    expect(createApiClient).not.toHaveBeenCalled()
  })
})
