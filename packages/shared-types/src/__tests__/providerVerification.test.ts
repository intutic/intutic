import { describe, expect, it } from 'vitest'
import { buildVerificationProbe, classifyProbeResponse, parseProviderModels } from '../providerVerification.js'
import { PROVIDER_REGISTRY } from '../providers.js'

describe('classifyProbeResponse', () => {
  it.each([
    [200, 'valid'],
    [201, 'valid'],
    [299, 'valid'],
    [401, 'invalid'],
    [403, 'invalid'],
    [400, 'unknown'],
    [404, 'unknown'],
    [429, 'unknown'],
    [500, 'unknown'],
    [503, 'unknown'],
  ] as const)('classifies HTTP %i as %s', (status, expected) => {
    expect(classifyProbeResponse(status)).toBe(expected)
  })
})

describe('buildVerificationProbe', () => {
  it('builds an Anthropic probe as a bodiless GET /v1/models listing every model, never /v1/chat/completions', () => {
    const probe = buildVerificationProbe('anthropic', { apiKey: 'ant-test-key' })
    expect(probe).not.toBeNull()
    expect(probe!.method).toBe('GET')
    expect(probe!.url).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(probe!.url).not.toContain('/v1/chat/completions')
    expect(probe!.headers['x-api-key']).toBe('ant-test-key')
    expect(probe!.headers['anthropic-version']).toBe('2023-06-01')
    expect(probe!.body).toBeUndefined()
  })

  it('builds an OpenAI-shaped GET /v1/models probe for OpenAI-compatible providers', () => {
    for (const provider of ['openai', 'mistral', 'openrouter', 'deepseek', 'cohere']) {
      const probe = buildVerificationProbe(provider, { apiKey: 'test-key' })
      expect(probe, `expected a probe for ${provider}`).not.toBeNull()
      expect(probe!.method).toBe('GET')
      expect(probe!.url).toContain('/v1/models')
      expect(probe!.url).not.toContain('/v1/chat/completions')
      expect(probe!.headers.Authorization).toBe('Bearer test-key')
    }
  })

  it('builds a Gemini probe with the key as a query param, not a header', () => {
    const probe = buildVerificationProbe('gemini', { apiKey: 'test-key' })
    expect(probe).not.toBeNull()
    expect(probe!.url).toContain('key=test-key')
    expect(probe!.url).toContain('pageSize=1000')
  })

  it('builds an Azure OpenAI probe using the endpoint field, trimming a trailing slash', () => {
    const probe = buildVerificationProbe('azure_openai', {
      apiKey: 'test-key',
      endpoint: 'https://my-resource.openai.azure.com/',
    })
    expect(probe).not.toBeNull()
    expect(probe!.url).toBe('https://my-resource.openai.azure.com/openai/models?api-version=2024-02-01')
    expect(probe!.headers['api-key']).toBe('test-key')
  })

  it('strips many repeated trailing slashes without a regex-driven slowdown (CodeQL polynomial-regex regression)', () => {
    // The original implementation used endpoint.replace(/\/+$/, ''), which
    // CodeQL flagged as a polynomial regular expression on uncontrolled
    // input. This is the regression guard: a pathological run of trailing
    // slashes must resolve instantly and strip completely, not just "not
    // crash" -- a hang here would fail the test's own timeout, not silently
    // pass.
    const pathological = 'https://my-resource.openai.azure.com' + '/'.repeat(50_000)
    const started = Date.now()
    const probe = buildVerificationProbe('azure_openai', {
      apiKey: 'test-key',
      endpoint: pathological,
    })
    expect(Date.now() - started).toBeLessThan(100)
    expect(probe!.url).toBe('https://my-resource.openai.azure.com/openai/models?api-version=2024-02-01')
  })

  it('builds an Ollama reachability probe with no auth header', () => {
    const probe = buildVerificationProbe('ollama', { apiBase: 'http://localhost:11434' })
    expect(probe).not.toBeNull()
    expect(probe!.url).toBe('http://localhost:11434/api/tags')
    expect(Object.keys(probe!.headers)).toHaveLength(0)
  })

  it('returns null for Bedrock and Vertex AI (SigV4 / OAuth2 signing not implemented)', () => {
    expect(buildVerificationProbe('bedrock', { awsAccessKeyId: 'x', awsSecretAccessKey: 'y', awsRegion: 'us-east-1' })).toBeNull()
    expect(buildVerificationProbe('vertex_ai', { projectId: 'p', serviceAccountJson: '{}' })).toBeNull()
  })

  it('returns null when required fields are missing', () => {
    expect(buildVerificationProbe('anthropic', {})).toBeNull()
    expect(buildVerificationProbe('azure_openai', { apiKey: 'x' })).toBeNull()
    expect(buildVerificationProbe('ollama', {})).toBeNull()
  })

  it('returns null for an unknown provider id', () => {
    expect(buildVerificationProbe('not-a-real-provider', { apiKey: 'x' })).toBeNull()
  })

  it('never builds a probe request against /v1/chat/completions for any registry provider', () => {
    // Mirrors monitorSeparation.test.ts's own census of that URL shape — a
    // verification probe must never become a new site that test has to
    // classify as a judge/generation call.
    const sampleFieldsByType: Record<string, string> = {
      text: 'sample',
      password: 'sample-secret',
      textarea: '{"type":"service_account"}',
    }
    for (const def of PROVIDER_REGISTRY) {
      const fields: Record<string, string> = {}
      for (const field of def.fields) {
        fields[field.key] = sampleFieldsByType[field.type]
      }
      const probe = buildVerificationProbe(def.id, fields)
      if (probe) {
        expect(probe.url).not.toContain('/v1/chat/completions')
      }
    }
  })
})

describe('parseProviderModels', () => {
  it.each(['anthropic', 'openai', 'mistral', 'openrouter', 'deepseek'])('%s: data[].id, deduplicated and sorted', (provider) => {
    const body = { data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-b' }, { id: 42 }, { name: 'no-id' }, null, 'bare'], has_more: false }
    expect(parseProviderModels(provider, body)).toEqual(['model-a', 'model-b'])
  })

  it('gemini: models[].name without the models/ prefix', () => {
    const body = { models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-2.5-flash' }, { name: 'tuned-x' }] }
    expect(parseProviderModels('gemini', body)).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro', 'tuned-x'])
  })

  it.each(['cohere', 'ollama'])('%s: models[].name', (provider) => {
    const body = { models: [{ name: 'llama3.1:8b' }, { name: 'command-r' }, { name: '' }] }
    expect(parseProviderModels(provider, body)).toEqual(['command-r', 'llama3.1:8b'])
  })

  it('returns null for providers whose probe does not list requestable models', () => {
    const body = { data: [{ id: 'gpt-4o' }] }
    for (const provider of ['azure_openai', 'bedrock', 'vertex_ai', 'not-a-provider']) {
      expect(parseProviderModels(provider, body), provider).toBeNull()
    }
  })

  it('returns null for a body that is not the expected shape, and [] for an empty list', () => {
    expect(parseProviderModels('openai', null)).toBeNull()
    expect(parseProviderModels('openai', 'text')).toBeNull()
    expect(parseProviderModels('openai', { data: 'nope' })).toBeNull()
    expect(parseProviderModels('gemini', { data: [{ id: 'x' }] })).toBeNull()
    expect(parseProviderModels('openai', { data: [] })).toEqual([])
  })
})
