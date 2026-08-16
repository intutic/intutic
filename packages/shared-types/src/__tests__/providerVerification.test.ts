import { describe, expect, it } from 'vitest'
import { buildVerificationProbe, classifyProbeResponse } from '../providerVerification.js'
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
  it('builds an Anthropic probe as a 1-token POST /v1/messages, never /v1/chat/completions', () => {
    const probe = buildVerificationProbe('anthropic', { apiKey: 'sk-ant-test' })
    expect(probe).not.toBeNull()
    expect(probe!.method).toBe('POST')
    expect(probe!.url).toContain('/v1/messages')
    expect(probe!.url).not.toContain('/v1/chat/completions')
    expect(probe!.headers['x-api-key']).toBe('sk-ant-test')
    expect(JSON.parse(probe!.body!).max_tokens).toBe(1)
  })

  it('builds an OpenAI-shaped GET /v1/models probe for OpenAI-compatible providers', () => {
    for (const provider of ['openai', 'mistral', 'openrouter', 'cohere']) {
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
  })

  it('builds an Azure OpenAI probe using the endpoint field, trimming a trailing slash', () => {
    const probe = buildVerificationProbe('azure_openai', {
      apiKey: 'test-key',
      endpoint: 'https://my-resource.openai.azure.com/',
      deploymentName: 'gpt-4o-deployment',
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
      deploymentName: 'gpt-4o-deployment',
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
