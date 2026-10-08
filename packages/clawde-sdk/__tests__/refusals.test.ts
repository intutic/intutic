import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { PROXY_REFUSALS, parseRefusal } from '../src/refusals'

const STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
}

/**
 * 4xx errors the proxy returns that are not governance decisions: credentials,
 * workspace binding, a malformed request or route. A new 4xx code in proxy.rs
 * must land here or in PROXY_REFUSALS.
 */
const NOT_REFUSALS = new Set([
  'missing_key',
  'vk_required',
  'unauthorized',
  'workspace_mismatch',
  'org_mismatch',
  'invalid_body',
  'unsupported_route',
  'byok_required',
  'no_upstream_credential',
])

/** Every `json_error(StatusCode::X, "code", ...)` in the proxy, as [status, code]. */
function proxyErrors(): Array<[number, string]> {
  const source = readFileSync(join(__dirname, '../../proxy/src/proxy.rs'), 'utf-8')
  const found: Array<[number, string]> = []
  for (const m of source.matchAll(/json_error\(\s*StatusCode::([A-Z_]+),\s*"([A-Za-z_]+)"/g)) {
    expect(STATUS[m[1]], `unmapped StatusCode::${m[1]}`).toBeDefined()
    found.push([STATUS[m[1]], m[2]])
  }
  return found
}

describe('proxy refusals', () => {
  const errors = proxyErrors()

  it('reads the proxy source', () => {
    expect(errors.length).toBeGreaterThan(20)
  })

  it('pairs every refusal with the status the proxy sends it with', () => {
    for (const [code, { status }] of Object.entries(PROXY_REFUSALS)) {
      const statuses = errors.filter(([, c]) => c === code).map(([s]) => s)
      expect(statuses, code).not.toHaveLength(0)
      expect(new Set(statuses), code).toEqual(new Set([status]))
    }
  })

  it('classifies every 4xx code the proxy sends', () => {
    const unclassified = errors
      .filter(([status, code]) => status < 500 && !(code in PROXY_REFUSALS) && !NOT_REFUSALS.has(code))
      .map(([status, code]) => `${status} ${code}`)
    expect(unclassified).toEqual([])
  })

  it('needs the status and the code to agree', () => {
    const body = JSON.stringify({ error: { type: 'policy_denied', message: 'no' } })
    expect(parseRefusal(403, body)).toEqual({ verdict: 'kill', code: 'policy_denied', message: 'no' })
    expect(parseRefusal(409, body)).toBeNull()
    expect(parseRefusal(403, 'not json')).toBeNull()
    expect(parseRefusal(403, JSON.stringify({ error: 'policy_denied' }))).toBeNull()
  })
})
