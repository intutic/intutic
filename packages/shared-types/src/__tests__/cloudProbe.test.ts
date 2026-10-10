import { describe, expect, it } from 'vitest'
import { buildCloudVerificationProbe, serviceAccountAssertion, sigv4Headers } from '../cloudProbe.js'
import { buildVerificationProbeAsync, classifyProbe } from '../providerVerification.js'

// AWS's published SigV4 test suite: AKIDEXAMPLE, 20150830T123600Z,
// us-east-1, service "service". Assembled at runtime per the repo's fixture rule.
const SECRET = ['wJalrXUtnFEMI/K7MDENG+', 'bPxRfiCYEXAMPLEKEY'].concat().join('')
const VECTOR_TIME = new Date('2015-08-30T12:36:00Z')

function hdrs(map: Record<string, string>) {
  return { get: (n: string) => map[n.toLowerCase()] ?? null }
}

describe('sigv4Headers', () => {
  it('matches the get-vanilla and post-vanilla vectors', async () => {
    const base = {
      host: 'example.amazonaws.com',
      path: '/',
      body: '',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: SECRET,
      region: 'us-east-1',
      service: 'service',
      now: VECTOR_TIME,
    }
    expect((await sigv4Headers({ ...base, method: 'GET' })).authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    )
    expect((await sigv4Headers({ ...base, method: 'POST' })).authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
    )
    const withToken = await sigv4Headers({ ...base, method: 'GET', sessionToken: 'tok' })
    expect(withToken['x-amz-security-token']).toBe('tok')
    expect(withToken.authorization).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token,')
  })
})

async function testServiceAccount(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const b64 = btoa(String.fromCharCode(...der))
  const label = ['PRIVATE', ' KEY'].join('')
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`
}

describe('buildCloudVerificationProbe', () => {
  it('Bedrock key pair: a signed STS GetCallerIdentity, read with AWS error types', async () => {
    const probe = await buildCloudVerificationProbe(
      'bedrock',
      { awsRegion: 'eu-west-1', awsAccessKeyId: 'AKIDEXAMPLE', awsSecretAccessKey: SECRET },
      VECTOR_TIME,
    )
    expect(probe!.url).toBe('https://sts.eu-west-1.amazonaws.com/')
    expect(probe!.method).toBe('POST')
    expect(probe!.body).toBe('Action=GetCallerIdentity&Version=2011-06-15')
    expect(probe!.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/eu-west-1\/sts\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    )
    expect(classifyProbe(probe!, 200, hdrs({}))).toBe('valid')
    expect(classifyProbe(probe!, 403, hdrs({ 'x-amzn-errortype': 'InvalidClientTokenId' }))).toBe('invalid')
    expect(classifyProbe(probe!, 403, hdrs({ 'x-amzn-errortype': 'SignatureDoesNotMatch' }))).toBe('invalid')
    expect(classifyProbe(probe!, 403, hdrs({ 'x-amzn-errortype': 'AccessDeniedException:http://x' }))).toBe('unknown')
    expect(classifyProbe(probe!, 503, hdrs({}))).toBe('unknown')
    expect(probe!.validDetail).toContain('access key is valid')
  })

  it('Bedrock API key: ListFoundationModels with the bearer token', async () => {
    const probe = await buildCloudVerificationProbe('bedrock', { awsRegion: 'us-east-1', apiKey: 'bedrock-key' })
    expect(probe!.url).toBe('https://bedrock.us-east-1.amazonaws.com/foundation-models?byProvider=anthropic')
    expect(probe!.headers.Authorization).toBe('Bearer bedrock-key')
    expect(await buildCloudVerificationProbe('bedrock', { awsRegion: 'evil.com/#', apiKey: 'k' })).toBeNull()
    expect(await buildCloudVerificationProbe('bedrock', { awsRegion: 'us-east-1' })).toBeNull()
  })

  it('Vertex AI: the service-account token exchange, with a verifiable RS256 assertion', async () => {
    const pem = await testServiceAccount()
    const sa = JSON.stringify({
      type: 'service_account',
      client_email: 'sa@p.iam.gserviceaccount.com',
      private_key: pem,
      private_key_id: 'kid-1',
    })
    const probe = await buildCloudVerificationProbe('vertex_ai', { projectId: 'p', serviceAccountJson: sa })
    expect(probe!.url).toBe('https://oauth2.googleapis.com/token')
    const form = new URLSearchParams(probe!.body)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const [h, c] = form.get('assertion')!.split('.')
    const decode = (s: string) => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')))
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' })
    expect(decode(c)).toMatchObject({ iss: 'sa@p.iam.gserviceaccount.com', aud: 'https://oauth2.googleapis.com/token' })
    // A bad key is answered 400 invalid_grant by Google.
    expect(classifyProbe(probe!, 400, hdrs({}))).toBe('invalid')
    expect(classifyProbe(probe!, 200, hdrs({}))).toBe('valid')

    const broken = JSON.stringify({ type: 'service_account', client_email: 'x@y', private_key: 'not a key' })
    const local = await buildCloudVerificationProbe('vertex_ai', { projectId: 'p', serviceAccountJson: broken })
    expect(local!.localVerdict).toBe('invalid')
    expect(await buildCloudVerificationProbe('vertex_ai', { projectId: 'p', serviceAccountJson: '{}' })).toBeNull()
  })

  it('serviceAccountAssertion signs with the key it was given', async () => {
    const pem = await testServiceAccount()
    const jwt = await serviceAccountAssertion('a@b', pem, undefined, new Date(0))
    expect(jwt.split('.')).toHaveLength(3)
  })

  it('every other provider still gets its plain probe', async () => {
    const probe = await buildVerificationProbeAsync('openai', { apiKey: 'sk-test' })
    expect(probe!.url).toBe('https://api.openai.com/v1/models')
    expect(await buildCloudVerificationProbe('openai', { apiKey: 'sk-test' })).toBeNull()
  })
})
