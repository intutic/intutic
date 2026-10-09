import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  PROXY_REFUSALS,
  REFUSAL_HEADER,
  REFUSAL_RULE_HEADER,
  STREAM_REFUSAL_MARKER,
  parseRefusal,
  streamRefusal,
} from '../src/refusals'

/** The one list of refusal codes the proxy, both SDKs and the docs are held to. */
const SHARED = JSON.parse(
  readFileSync(join(__dirname, '../../shared-types/fixtures/refusal-codes.json'), 'utf-8'),
).proxy as {
  header: string
  ruleHeader: string
  streamMarker: string
  refusals: Array<{ code: string; status: number; verdict: string; inBand: boolean; meaning: string }>
  notRefusals: string[]
}

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

  it('is the shared list, code for code', () => {
    expect(PROXY_REFUSALS).toEqual(
      Object.fromEntries(SHARED.refusals.map((r) => [r.code, { status: r.status, verdict: r.verdict }])),
    )
    expect([REFUSAL_HEADER, REFUSAL_RULE_HEADER, STREAM_REFUSAL_MARKER]).toEqual([
      SHARED.header,
      SHARED.ruleHeader,
      SHARED.streamMarker,
    ])
  })

  it('pairs every error-body refusal with the status the proxy sends it with', () => {
    for (const [code, { status }] of Object.entries(PROXY_REFUSALS)) {
      if (status === 200) continue
      const statuses = errors.filter(([, c]) => c === code).map(([s]) => s)
      expect(statuses, code).not.toHaveLength(0)
      expect(new Set(statuses), code).toEqual(new Set([status]))
    }
  })

  it('classifies every 4xx code the proxy sends', () => {
    const notRefusals = new Set(SHARED.notRefusals)
    const unclassified = errors
      .filter(([status, code]) => status < 500 && !(code in PROXY_REFUSALS) && !notRefusals.has(code))
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

describe('the clawde SDK reference', () => {
  it('documents every proxy refusal in one table, with its status and verdict', () => {
    const doc = readFileSync(join(__dirname, '../../../apps/docs/reference/clawde-sdk.md'), 'utf-8')
    const rows = [...doc.matchAll(/^\| ([^|]+) \| `([A-Za-z_]+)` \| `(kill|reask|hold)` \| ([^|]+) \|$/gm)].map(
      (m) => [m[2], m[1].trim(), m[3]],
    )
    const expected = SHARED.refusals.map((r) => [
      r.code,
      r.inBand && r.status !== 200 ? `${r.status}, or 200` : String(r.status),
      r.verdict,
    ])
    expect(rows).toEqual(expected)
  })
})

describe('the stream refusal marker', () => {
  const line = `${STREAM_REFUSAL_MARKER}${JSON.stringify({ code: 'TOOL_DENIED', rule: 'deny_tools.Bash', message: 'no Bash' })}`

  it('is found in a whole body or a single line', () => {
    const expected = { verdict: 'kill', code: 'TOOL_DENIED', message: 'no Bash', ruleId: 'deny_tools.Bash' }
    expect(streamRefusal(line)).toEqual(expected)
    expect(streamRefusal(`data: {"choices":[]}\n\n${line}\n\ndata: [DONE]\n\n`)).toEqual(expected)
  })

  it('ignores every other line, other comments included', () => {
    expect(streamRefusal('data: {"choices":[]}\n\n: keep-alive\n\ndata: [DONE]\n\n')).toBeNull()
    expect(streamRefusal(`${STREAM_REFUSAL_MARKER}{not json`)).toBeNull()
    expect(streamRefusal(`${STREAM_REFUSAL_MARKER}{"rule":"x"}`)).toBeNull()
  })
})
