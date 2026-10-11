import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A logged-in machine: the workspace login must not reach a chaos sandbox.
// Assembled at runtime so no credential-shaped literal sits in the source.
const LOGIN = ['vk', 'chaos_test_login'].join('_')
vi.mock('../config/store.js', () => ({
  loadCredentials: async () => ({ apiKey: ['vk', 'chaos_test_login'].join('_'), workspaceId: 'ws_chaos' }),
}))

import { chaosSandboxEnv } from './chaos.js'
import { deriveIdentity } from '../lib/graphIdentity.js'

describe('chaosSandboxEnv', () => {
  const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY }

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'chaos-test-anthropic-placeholder'
    process.env.OPENAI_API_KEY = 'chaos-test-openai-placeholder'
  })

  afterEach(() => {
    for (const [name, value] of [['ANTHROPIC_API_KEY', saved.a], ['OPENAI_API_KEY', saved.o]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('hands the agent its own provider keys, never the workspace login, because the repetition proxy is standalone', () => {
    const env = chaosSandboxEnv(deriveIdentity({}), 41234)
    expect(env.ANTHROPIC_API_KEY).toBe('chaos-test-anthropic-placeholder')
    expect(env.OPENAI_API_KEY).toBe('chaos-test-openai-placeholder')
    expect(env.INTUTIC_API_KEY).toBeUndefined()
    expect(Object.values(env)).not.toContain(LOGIN)
  })

  it('points the agent at the repetition proxy on the given port', () => {
    const env = chaosSandboxEnv(deriveIdentity({}), 41234)
    expect(env.INTUTIC_SANDBOX_PROXY_PORT).toBe('41234')
  })
})
