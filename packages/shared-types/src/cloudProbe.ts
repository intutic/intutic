/**
 * Verification probes for cloud provider credentials: AWS Bedrock and Google
 * Vertex AI, whose cheapest authenticated call has to be signed per request.
 *
 * Still no network here: this builds the request (SigV4-signed, or carrying a
 * freshly signed service-account assertion) with WebCrypto, which Node and
 * browsers both provide, and the executors in the CLI and the control plane
 * send it exactly as they send every other provider's probe.
 *
 * - **Bedrock, access key pair**: STS `GetCallerIdentity`, which any valid
 *   key may call — it proves the key, not its Bedrock permissions, which the
 *   first model call checks.
 *   <https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html>
 * - **Bedrock, API key**: `ListFoundationModels` with the key as a bearer
 *   token (Bedrock API keys work with Bedrock control-plane actions).
 *   <https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html>
 * - **Vertex AI**: the service account's OAuth token exchange — the key is
 *   valid when Google mints a token for it; project access is checked on the
 *   first model call. An `authorized_user` file is checked by its refresh
 *   grant.
 *
 * @module
 */

import type { ProbeVerdict, ProviderProbeRequest } from './providerVerification.js'

const enc = new TextEncoder()

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('WebCrypto is not available in this runtime')
  return s
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(data: string): Promise<string> {
  return hex(await subtle().digest('SHA-256', enc.encode(data)))
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await subtle().importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return subtle().sign('HMAC', k, enc.encode(data))
}

/** RFC 3986 encoding as SigV4 requires it (unreserved characters kept). */
function uriEncode(s: string): string {
  return [...enc.encode(s)]
    .map((b) => {
      const c = String.fromCharCode(b)
      return /[A-Za-z0-9\-_.~]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`
    })
    .join('')
}

export interface SigV4Input {
  method: string
  host: string
  path: string
  query?: Array<[string, string]>
  /** Headers to sign besides `host` and `x-amz-date`. */
  headers?: Record<string, string>
  body: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
  service: string
  now: Date
}

/**
 * AWS Signature Version 4: the headers to add (`x-amz-date`,
 * `x-amz-security-token` for temporary credentials, `authorization`).
 * Held to AWS's published test-suite vectors in this package's tests.
 */
export async function sigv4Headers(i: SigV4Input): Promise<Record<string, string>> {
  const amzDate = i.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const date = amzDate.slice(0, 8)
  const signed: Array<[string, string]> = Object.entries(i.headers ?? {}).map(([k, v]) => [
    k.toLowerCase(),
    v.trim().replace(/\s+/g, ' '),
  ])
  signed.push(['host', i.host.toLowerCase()], ['x-amz-date', amzDate])
  if (i.sessionToken) signed.push(['x-amz-security-token', i.sessionToken])
  signed.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = (i.query ?? [])
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const signedNames = signed.map(([k]) => k).join(';')
  const canonical = [
    i.method,
    i.path,
    query,
    signed.map(([k, v]) => `${k}:${v}\n`).join(''),
    signedNames,
    await sha256Hex(i.body),
  ].join('\n')
  const scope = `${date}/${i.region}/${i.service}/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonical)}`
  let key = await hmac(enc.encode(`AWS4${i.secretAccessKey}`), date)
  key = await hmac(key, i.region)
  key = await hmac(key, i.service)
  key = await hmac(key, 'aws4_request')
  const signature = hex(await hmac(key, stringToSign))
  const out: Record<string, string> = { 'x-amz-date': amzDate }
  if (i.sessionToken) out['x-amz-security-token'] = i.sessionToken
  out.authorization = `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedNames}, Signature=${signature}`
  return out
}

function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** An RS256 JWT bearer assertion for Google's token endpoint. */
export async function serviceAccountAssertion(
  clientEmail: string,
  privateKeyPem: string,
  privateKeyId: string | undefined,
  now: Date,
): Promise<string> {
  const der = Uint8Array.from(
    atob(privateKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')),
    (c) => c.charCodeAt(0),
  )
  const key = await subtle().importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const iat = Math.floor(now.getTime() / 1000)
  const header = { alg: 'RS256', typ: 'JWT', ...(privateKeyId ? { kid: privateKeyId } : {}) }
  const claims = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: GOOGLE_TOKEN_URI,
    iat,
    exp: iat + 3600,
  }
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  const sig = await subtle().sign('RSASSA-PKCS1-v1_5', key, enc.encode(input))
  return `${input}.${b64url(sig)}`
}

export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'

const AWS_INVALID = new Set([
  'UnrecognizedClientException',
  'InvalidClientTokenId',
  'SignatureDoesNotMatch',
  'InvalidSignatureException',
  'ExpiredToken',
  'ExpiredTokenException',
  'IncompleteSignature',
])

/** AWS: a credential error is invalid; `AccessDenied` means the key authenticated but lacks the permission. */
function classifyAws(status: number, headers: { get(name: string): string | null }): ProbeVerdict {
  if (status >= 200 && status < 300) return 'valid'
  const type = (headers.get('x-amzn-errortype') ?? '').split(':')[0]
  if (AWS_INVALID.has(type)) return 'invalid'
  if (status === 401) return 'invalid'
  if (status === 403 && !type.startsWith('AccessDenied')) return 'invalid'
  return 'unknown'
}

/** Google's token endpoint answers a bad key with 400 `invalid_grant` or 401 `invalid_client`. */
function classifyGoogleToken(status: number): ProbeVerdict {
  if (status >= 200 && status < 300) return 'valid'
  if (status === 400 || status === 401 || status === 403) return 'invalid'
  return 'unknown'
}

const REGION = /^[a-z0-9-]{1,32}$/

/**
 * The verification request for a Bedrock or Vertex AI credential, or `null`
 * when `fields` are not a complete credential for one.
 */
export async function buildCloudVerificationProbe(
  provider: string,
  fields: Record<string, string>,
  now: Date = new Date(),
): Promise<ProviderProbeRequest | null> {
  if (provider === 'bedrock') {
    const region = fields.awsRegion?.trim()
    if (!region || !REGION.test(region)) return null
    if (fields.awsAccessKeyId && fields.awsSecretAccessKey) {
      const host = `sts.${region}.amazonaws.com`
      const body = 'Action=GetCallerIdentity&Version=2011-06-15'
      const contentType = 'application/x-www-form-urlencoded; charset=utf-8'
      const signed = await sigv4Headers({
        method: 'POST',
        host,
        path: '/',
        headers: { 'content-type': contentType },
        body,
        accessKeyId: fields.awsAccessKeyId.trim(),
        secretAccessKey: fields.awsSecretAccessKey.trim(),
        region,
        service: 'sts',
        now,
      })
      return {
        url: `https://${host}/`,
        method: 'POST',
        headers: { 'content-type': contentType, ...signed },
        body,
        classify: classifyAws,
        validDetail: 'the access key is valid; Bedrock model access is checked on the first request',
      }
    }
    if (fields.apiKey) {
      return {
        url: `https://bedrock.${region}.amazonaws.com/foundation-models?byProvider=anthropic`,
        method: 'GET',
        headers: { Authorization: `Bearer ${fields.apiKey.trim()}` },
        classify: classifyAws,
      }
    }
    return null
  }

  if (provider === 'vertex_ai') {
    let doc: Record<string, string>
    try {
      doc = JSON.parse(fields.serviceAccountJson ?? '') as Record<string, string>
    } catch {
      return null
    }
    if (doc.type === 'service_account' && doc.client_email && doc.private_key) {
      let assertion: string
      try {
        assertion = await serviceAccountAssertion(doc.client_email, doc.private_key, doc.private_key_id, now)
      } catch {
        // A key that will not import is as invalid as one Google rejects.
        return {
          url: GOOGLE_TOKEN_URI,
          method: 'POST',
          headers: {},
          localVerdict: 'invalid',
          validDetail: 'the service-account private_key is not a usable RSA key',
        }
      }
      return {
        url: GOOGLE_TOKEN_URI,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
        classify: classifyGoogleToken,
        validDetail: 'the service-account key is valid; project access is checked on the first request',
      }
    }
    if (doc.type === 'authorized_user' && doc.client_id && doc.refresh_token) {
      return {
        url: GOOGLE_TOKEN_URI,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: doc.client_id,
          client_secret: doc.client_secret ?? '',
          refresh_token: doc.refresh_token,
        }).toString(),
        classify: classifyGoogleToken,
      }
    }
    return null
  }

  return null
}
