/**
 * Judges are self-hosted only (owner rule, 2026-10-03; LLD #72): the
 * registry holds no credential for a hosted judge vendor. TypeSafe (Jev) and
 * Fastino (GLiDE) were registered as judge-only keys and are removed.
 */
import { describe, it, expect } from 'vitest'
import {
  AZURE_ENDPOINT_HOST_SUFFIXES,
  PROVIDER_REGISTRY,
  checkCloudCredentialFields,
  cloudProviderForModel,
  getProviderDefinition,
} from '../providers.js'

describe('provider registry', () => {
  it('registers no hosted judge vendor', () => {
    expect(getProviderDefinition('typesafe')).toBeUndefined()
    expect(getProviderDefinition('fastino')).toBeUndefined()
    expect(PROVIDER_REGISTRY.some((p) => 'judgeOnly' in p)).toBe(false)
  })
})

describe('cloud providers', () => {
  it('are routed by the proxy and declare how requests name them', () => {
    for (const id of ['bedrock', 'vertex_ai', 'azure_openai']) {
      const def = getProviderDefinition(id)!
      expect(def.routingLive, id).toBe(true)
      expect(def.usageHint, id).toBeTruthy()
    }
    // Every requiresOneOf key is a declared, individually optional field.
    for (const def of PROVIDER_REGISTRY) {
      for (const key of (def.requiresOneOf ?? []).flat()) {
        const field = def.fields.find((f) => f.key === key)
        expect(field, `${def.id}.${key}`).toBeDefined()
        expect(field!.required, `${def.id}.${key}`).toBe(false)
      }
    }
  })

  it('cloudProviderForModel reads the same prefixes as the proxy', () => {
    expect(cloudProviderForModel('bedrock/anthropic.claude-opus-4-7')).toBe('bedrock')
    expect(cloudProviderForModel('VERTEX/gemini-2.5-pro')).toBe('vertex_ai')
    expect(cloudProviderForModel('vertex_ai/claude-sonnet-4-5@20250929')).toBe('vertex_ai')
    expect(cloudProviderForModel('azure/my-deployment')).toBe('azure_openai')
    expect(cloudProviderForModel('azure/')).toBeUndefined()
    expect(cloudProviderForModel('anthropic/claude-3-opus')).toBeUndefined()
    expect(cloudProviderForModel('claude-sonnet-4-5')).toBeUndefined()
  })

  it('checkCloudCredentialFields refuses what the proxy would refuse', () => {
    expect(checkCloudCredentialFields('bedrock', { awsRegion: 'us-east-1' })).toBeNull()
    expect(checkCloudCredentialFields('bedrock', { awsRegion: 'us-east-1.evil.com' })).not.toBeNull()
    expect(
      checkCloudCredentialFields('vertex_ai', { projectId: 'p-1', serviceAccountJson: '{"type":"service_account"}' }),
    ).toBeNull()
    expect(
      checkCloudCredentialFields('vertex_ai', { projectId: 'p-1', location: 'x/y', serviceAccountJson: '{"type":"service_account"}' }),
    ).not.toBeNull()
    expect(checkCloudCredentialFields('vertex_ai', { projectId: 'p-1', serviceAccountJson: 'not json' })).not.toBeNull()
    expect(AZURE_ENDPOINT_HOST_SUFFIXES).toContain('.openai.azure.com')
    expect(checkCloudCredentialFields('azure_openai', { endpoint: 'https://res-1.openai.azure.com/' })).toBeNull()
    expect(checkCloudCredentialFields('azure_openai', { endpoint: 'https://res.services.ai.azure.com' })).toBeNull()
    for (const bad of [
      'http://res.openai.azure.com',
      'https://res.openai.azure.com.evil.net',
      'https://openai.azure.com',
      'https://res.openai.azure.com:8443',
      'https://a.b.openai.azure.com',
      'not a url',
    ]) {
      expect(checkCloudCredentialFields('azure_openai', { endpoint: bad }), bad).not.toBeNull()
    }
    expect(checkCloudCredentialFields('anthropic', { apiKey: 'x' })).toBeNull()
  })
})
