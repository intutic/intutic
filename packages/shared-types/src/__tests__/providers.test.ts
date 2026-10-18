/**
 * Judges are self-hosted only (owner rule, 2026-10-03). TypeSafe (Jev) and
 * Fastino (GLiDE) were once registered as judge-only keys and were removed.
 * They are registered again, on purpose, as providers of kind `decision`: a
 * customer's own calls to their decision models, which the proxy forwards and
 * governs like LLM calls. A decision key is customer traffic only, never a
 * judge's; the control plane's selfHostedJudges.test.ts holds the judge side.
 */
import { describe, it, expect } from 'vitest'
import {
  AZURE_ENDPOINT_HOST_SUFFIXES,
  PROVIDER_REGISTRY,
  checkCloudCredentialFields,
  cloudProviderForModel,
  decisionProviderIds,
  getProviderDefinition,
  inferProviderForModel,
} from '../providers.js'

describe('provider registry', () => {
  it('registers typesafe and fastino as customer-traffic providers of kind decision', () => {
    expect(decisionProviderIds()).toEqual(['typesafe', 'fastino'])
    for (const id of ['typesafe', 'fastino']) {
      const def = getProviderDefinition(id)!
      expect(def, id).toBeDefined()
      expect(def.kind, id).toBe('decision')
      // The proxy forwards decision traffic to them (/v1/systemone).
      expect(def.routingLive, id).toBe(true)
      expect(def.usageHint, id).toContain('/v1/systemone')
      expect(def.fields.map((f) => f.key), id).toEqual(['apiKey'])
    }
  })

  it('never makes a decision provider usable as a judge or an LLM target', () => {
    expect(PROVIDER_REGISTRY.some((p) => 'judgeOnly' in p)).toBe(false)
    // No model name routes to a decision provider as an LLM call: the proxy
    // reaches them only on the decision routes.
    for (const model of ['jev-1.14.0', 'typesafe/jev-1.14.0', 'fastino/GLiDE', 'kev-4b']) {
      expect(decisionProviderIds(), model).not.toContain(inferProviderForModel(model))
    }
    // Every other provider is an LLM provider.
    for (const p of PROVIDER_REGISTRY.filter((d) => !decisionProviderIds().includes(d.id))) {
      expect(p.kind, p.id).toBeUndefined()
    }
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
