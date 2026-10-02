/**
 * Provider registry entries that carry rules beyond their field layout.
 * TypeSafe (LLD #72 Phase 7) is a judge credential, not a routing target.
 */
import { describe, it, expect } from 'vitest'
import { PROVIDER_REGISTRY, LIVE_ROUTING_PROVIDER_IDS, getProviderDefinition } from '../providers.js'
import { buildVerificationProbe } from '../providerVerification.js'
import { DEFAULT_WORKSPACE_SETTINGS, TYPED_JUDGE_BACKENDS } from '../workspaceSettings.js'

describe('typesafe provider', () => {
  const def = getProviderDefinition('typesafe')

  it('is registered with one required secret field, apiKey', () => {
    expect(def).toBeDefined()
    expect(def!.displayName).toBe('TypeSafe (Jev judge)')
    expect(def!.docsUrl).toBe('https://docs.typesafe.ai')
    expect(def!.fields).toEqual([{ key: 'apiKey', label: 'API Key', type: 'password', required: true }])
  })

  it('is judge-only: never routable and stored as a config blob, not a flat field', () => {
    expect(def!.judgeOnly).toBe(true)
    expect(def!.routingLive).toBe(false)
    expect((LIVE_ROUTING_PROVIDER_IDS as readonly string[]).includes('typesafe')).toBe(false)
  })

  it('is the only judge-only provider, and no routable provider is judge-only', () => {
    expect(PROVIDER_REGISTRY.filter((p) => p.judgeOnly).map((p) => p.id)).toEqual(['typesafe'])
    expect(PROVIDER_REGISTRY.some((p) => p.judgeOnly && p.routingLive)).toBe(false)
  })

  it('has no automatic verification probe (a Jev call is a judged request, not a free check)', () => {
    expect(buildVerificationProbe('typesafe', { apiKey: ['ts', 'fixture', 'key'].join('_') })).toBeNull()
  })
})

describe('typedJudgeBackend setting', () => {
  it('defaults to the platform typed judge', () => {
    expect(DEFAULT_WORKSPACE_SETTINGS.typedJudgeBackend).toBe('platform')
    expect([...TYPED_JUDGE_BACKENDS]).toEqual(['platform', 'jev'])
  })
})
