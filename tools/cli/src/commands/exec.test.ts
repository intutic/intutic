import { describe, it, expect } from 'vitest'
import { buildProxyEnv } from './exec.js'

describe('Subprocess Exec Env Builder', () => {
  it('correctly maps proxy URLs in dev mode', () => {
    const apiKey = 'intk_test12345'
    const env = buildProxyEnv(apiKey, true)

    expect(env.OPENAI_API_BASE).toBe('http://localhost:4000/v1')
    expect(env.OPENAI_BASE_URL).toBe('http://localhost:4000/v1')
    expect(env.OPENAI_API_BASE_URL).toBe('http://localhost:4000/v1')
    expect(env.OPENAI_HOST).toBe('http://localhost:4000')
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:4000')
    
    expect(env.OPENAI_API_KEY).toBe(apiKey)
    expect(env.ANTHROPIC_API_KEY).toBe(apiKey)
    expect(env.INTUTIC_API_KEY).toBe(apiKey)
  })

  it('correctly maps proxy URLs in production mode', () => {
    const apiKey = 'intk_prod98765'
    const env = buildProxyEnv(apiKey, false)

    expect(env.OPENAI_API_BASE).toBe('https://proxy.intutic.ai/v1')
    expect(env.OPENAI_BASE_URL).toBe('https://proxy.intutic.ai/v1')
    expect(env.OPENAI_API_BASE_URL).toBe('https://proxy.intutic.ai/v1')
    expect(env.OPENAI_HOST).toBe('https://proxy.intutic.ai')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.intutic.ai')
    
    expect(env.OPENAI_API_KEY).toBe(apiKey)
    expect(env.ANTHROPIC_API_KEY).toBe(apiKey)
    expect(env.INTUTIC_API_KEY).toBe(apiKey)
  })
})
