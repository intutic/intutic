import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_UPSTREAM_RETRY,
  UPSTREAM_PROVIDERS,
  UPSTREAM_RETRY_LIMITS,
  UpstreamRetrySettingsSchema,
} from '../upstreamRetry.js'

interface Vector {
  name: string
  setting: Record<string, unknown>
  schemaValid: boolean
  effective: Record<string, unknown>
}

const vectors: Vector[] = JSON.parse(
  readFileSync(new URL('../../fixtures/upstream-retry-vectors.json', import.meta.url), 'utf8'),
).cases

const retryRs = readFileSync(new URL('../../../proxy/src/routing/retry.rs', import.meta.url), 'utf8')

describe('upstreamRetry setting', () => {
  it.each(vectors)('$name', (v) => {
    expect(UpstreamRetrySettingsSchema.safeParse(v.setting).success).toBe(v.schemaValid)
    // A setting the schema accepts is laid over the defaults field by field,
    // which is what the proxy's `WorkspaceRetry::apply` does.
    if (v.schemaValid) {
      expect({ ...DEFAULT_UPSTREAM_RETRY, fallbacks: {}, ...v.setting }).toEqual(v.effective)
    }
  })

  it("matches the proxy's ceilings and defaults", () => {
    const rsConst = (name: string) => Number(retryRs.match(new RegExp(`${name}: u\\d+ = ([\\d_]+);`))?.[1].replace(/_/g, ''))
    expect(rsConst('MAX_ATTEMPTS_CEILING')).toBe(UPSTREAM_RETRY_LIMITS.maxAttempts)
    expect(rsConst('MAX_BACKOFF_CEILING_MS')).toBe(UPSTREAM_RETRY_LIMITS.maxBackoffMs)
    expect(rsConst('BUDGET_CEILING_MS')).toBe(UPSTREAM_RETRY_LIMITS.budgetMs)
    expect(retryRs).toContain(`MAX_FALLBACK_TARGETS: usize = ${UPSTREAM_RETRY_LIMITS.fallbackTargets};`)
    expect(retryRs).toContain(`[429, 500, 502, 503, 504, 529]`)
  })

  it("accepts exactly the provider ids the proxy resolves for a fallback target", () => {
    const proxyRs = readFileSync(new URL('../../../proxy/src/proxy.rs', import.meta.url), 'utf8')
    const body = proxyRs.slice(proxyRs.indexOf('fn provider_from_wire_id'))
    const arms = body.slice(0, body.indexOf('_ => None'))
    const ids = [...arms.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
    expect(ids.length).toBeGreaterThan(0)
    expect([...ids].sort()).toEqual([...UPSTREAM_PROVIDERS].sort())
    for (const provider of UPSTREAM_PROVIDERS) {
      expect(UpstreamRetrySettingsSchema.safeParse({ fallbacks: { 'claude-sonnet-4-5': [{ provider }] } }).success).toBe(true)
    }
    expect(UpstreamRetrySettingsSchema.safeParse({ fallbacks: { 'gpt-4o': [{ provider: 'cohere' }] } }).success).toBe(false)
  })

  it('refuses a target that names neither a model nor a provider', () => {
    const r = UpstreamRetrySettingsSchema.safeParse({ fallbacks: { 'gpt-4o': [{}] } })
    expect(r.success).toBe(false)
  })
})
