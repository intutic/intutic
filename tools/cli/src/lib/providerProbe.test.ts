import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { probeProviderCredential } from './providerProbe.js'

describe('probeProviderCredential', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('valid: 200 from the provider', async () => {
    fetchMock.mockResolvedValue({ status: 200 })
    const res = await probeProviderCredential('openai', { apiKey: 'sk-test' })
    expect(res.status).toBe('valid')
    expect(res.httpStatus).toBe(200)
  })

  it('invalid: 401 from the provider', async () => {
    fetchMock.mockResolvedValue({ status: 401 })
    const res = await probeProviderCredential('openai', { apiKey: 'sk-test' })
    expect(res.status).toBe('invalid')
  })

  it('unknown: 429 does not mean invalid', async () => {
    fetchMock.mockResolvedValue({ status: 429 })
    const res = await probeProviderCredential('openai', { apiKey: 'sk-test' })
    expect(res.status).toBe('unknown')
  })

  it('unknown: a thrown network error is caught, not propagated, and the message never leaks the key', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await probeProviderCredential('anthropic', { apiKey: 'sk-ant-super-secret-value' })
    expect(res.status).toBe('unknown')
    expect(res.detail).not.toContain('sk-ant-super-secret-value')
  })

  it('bedrock: a signed STS call; an unrecognised key is invalid', async () => {
    fetchMock.mockResolvedValue({ status: 403, headers: new Headers({ 'x-amzn-errortype': 'InvalidClientTokenId' }) })
    const res = await probeProviderCredential('bedrock', {
      awsAccessKeyId: 'AKIDTEST',
      awsSecretAccessKey: ['test', '-secret-', 'value'].join(''),
      awsRegion: 'us-east-1',
    })
    expect(res.status).toBe('invalid')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://sts.us-east-1.amazonaws.com/')
    expect((init.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\//)
    expect(res.detail).not.toContain('test-secret-value')
  })

  it('bedrock: a valid key says what was proven', async () => {
    fetchMock.mockResolvedValue({ status: 200, headers: new Headers() })
    const res = await probeProviderCredential('bedrock', {
      awsAccessKeyId: 'AKIDTEST',
      awsSecretAccessKey: 'secret',
      awsRegion: 'us-east-1',
    })
    expect(res.status).toBe('valid')
    expect(res.detail).toContain('Bedrock model access is checked on the first request')
  })

  it('vertex: an unusable private key is invalid without any request', async () => {
    const res = await probeProviderCredential('vertex_ai', {
      projectId: 'p',
      serviceAccountJson: JSON.stringify({ type: 'service_account', client_email: 'a@b', private_key: 'nope' }),
    })
    expect(res.status).toBe('invalid')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('unsupported: unknown provider id', async () => {
    const res = await probeProviderCredential('not-a-real-provider', { apiKey: 'x' })
    expect(res.status).toBe('unsupported')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the anthropic probe sends the real key upstream but the outcome never echoes it back', async () => {
    fetchMock.mockResolvedValue({ status: 200 })
    const secretKey = 'sk-ant-do-not-leak-me'
    const res = await probeProviderCredential('anthropic', { apiKey: secretKey })

    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(secretKey)
    expect(JSON.stringify(res)).not.toContain(secretKey)
  })
})
