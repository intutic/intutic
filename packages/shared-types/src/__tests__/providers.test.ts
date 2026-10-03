/**
 * Judges are self-hosted only (owner rule, 2026-10-03; LLD #72): the
 * registry holds no credential for a hosted judge vendor. TypeSafe (Jev) and
 * Fastino (GLiDE) were registered as judge-only keys and are removed.
 */
import { describe, it, expect } from 'vitest'
import { PROVIDER_REGISTRY, getProviderDefinition } from '../providers.js'

describe('provider registry', () => {
  it('registers no hosted judge vendor', () => {
    expect(getProviderDefinition('typesafe')).toBeUndefined()
    expect(getProviderDefinition('fastino')).toBeUndefined()
    expect(PROVIDER_REGISTRY.some((p) => 'judgeOnly' in p)).toBe(false)
  })
})
