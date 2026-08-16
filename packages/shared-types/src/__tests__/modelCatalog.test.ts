import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MODEL_CATALOG, findCatalogModel, judgeModelChoices, normalizeModelRef } from '../modelCatalog.js'
import { PROVIDER_REGISTRY, isKnownProviderId } from '../providers.js'

const GENERATED_FILE = fileURLToPath(new URL('../modelCatalog.generated.ts', import.meta.url))

describe('MODEL_CATALOG invariants', () => {
  it('is non-empty', () => {
    expect(MODEL_CATALOG.length).toBeGreaterThan(0)
  })

  it('every entry\'s provider is a known PROVIDER_REGISTRY id', () => {
    for (const entry of MODEL_CATALOG) {
      expect(isKnownProviderId(entry.provider), `unknown provider "${entry.provider}" on ${entry.ref}`).toBe(true)
    }
  })

  it('every entry\'s ref is exactly `${provider}/${id}`', () => {
    for (const entry of MODEL_CATALOG) {
      expect(entry.ref).toBe(`${entry.provider}/${entry.id}`)
    }
  })

  it('has no duplicate refs', () => {
    const refs = MODEL_CATALOG.map((e) => e.ref)
    expect(new Set(refs).size).toBe(refs.length)
  })

  it('every routingLive provider has at least one judgeCapable entry', () => {
    // Guards against a future upstream regen silently emptying the SaaS judge
    // picker's default list — see judgeModelChoices' saasRoutableOnly filter.
    const routableProviders = PROVIDER_REGISTRY.filter((p) => p.routingLive).map((p) => p.id)
    for (const providerId of routableProviders) {
      const hasJudgeCapable = MODEL_CATALOG.some((e) => e.provider === providerId && e.judgeCapable)
      expect(hasJudgeCapable, `no judgeCapable model for routable provider "${providerId}"`).toBe(true)
    }
  })

  it('judgeCapable entries meet the stated floor (>= 256 max output, >= 8192 context, not deprecated)', () => {
    for (const entry of MODEL_CATALOG) {
      if (!entry.judgeCapable) continue
      expect(entry.deprecated).toBe(false)
      expect(entry.maxOutputTokens ?? 0).toBeGreaterThanOrEqual(256)
      expect(entry.contextWindow ?? 0).toBeGreaterThanOrEqual(8192)
    }
  })

  it('modelCatalog.generated.ts still carries its GENERATED header', () => {
    // A hand-edit that strips the header is the failure mode this guards
    // against — the file is meant to be regenerated, never patched by hand.
    const text = readFileSync(GENERATED_FILE, 'utf-8')
    expect(text.startsWith('// GENERATED — do not edit by hand.')).toBe(true)
    expect(text).toContain('tools/scripts/build-offline-pricing-bundle.ts')
  })
})

describe('normalizeModelRef', () => {
  it('splits a clean ref into provider and id', () => {
    expect(normalizeModelRef('anthropic/claude-haiku-4-5')).toEqual({
      provider: 'anthropic',
      id: 'claude-haiku-4-5',
      ref: 'anthropic/claude-haiku-4-5',
    })
  })

  it('collapses a repeated provider prefix', () => {
    expect(normalizeModelRef('openai/openai/gpt-4o')).toEqual({
      provider: 'openai',
      id: 'gpt-4o',
      ref: 'openai/gpt-4o',
    })
  })

  it('collapses a triple-repeated provider prefix', () => {
    expect(normalizeModelRef('ollama/ollama/ollama/deepseek-r1')).toEqual({
      provider: 'ollama',
      id: 'deepseek-r1',
      ref: 'ollama/deepseek-r1',
    })
  })

  it('leaves an OpenRouter vendor segment alone (not a repeated prefix)', () => {
    expect(normalizeModelRef('openrouter/anthropic/claude-3-haiku')).toEqual({
      provider: 'openrouter',
      id: 'anthropic/claude-3-haiku',
      ref: 'openrouter/anthropic/claude-3-haiku',
    })
  })

  it('treats a bare model name (no slash) as an id with no provider', () => {
    expect(normalizeModelRef('gpt-4o')).toEqual({ id: 'gpt-4o' })
  })

  it('returns an empty id for an empty or whitespace-only input', () => {
    expect(normalizeModelRef('')).toEqual({ id: '' })
    expect(normalizeModelRef('   ')).toEqual({ id: '' })
  })
})

describe('findCatalogModel', () => {
  it('finds a known model by its canonical ref', () => {
    const sample = MODEL_CATALOG[0]
    expect(findCatalogModel(sample.ref)).toBe(sample)
  })

  it('finds a known model by its bare id', () => {
    const sample = MODEL_CATALOG.find((e) => e.provider === 'anthropic')
    expect(sample).toBeDefined()
    expect(findCatalogModel(sample!.id)?.ref).toBe(sample!.ref)
  })

  it('returns undefined for a model not in the catalog', () => {
    expect(findCatalogModel('nonexistent-provider/nonexistent-model-xyz')).toBeUndefined()
  })
})

describe('judgeModelChoices', () => {
  it('defaults to routable providers only', () => {
    const choices = judgeModelChoices()
    const routableIds = new Set(PROVIDER_REGISTRY.filter((p) => p.routingLive).map((p) => p.id))
    for (const c of choices) {
      expect(routableIds.has(c.provider)).toBe(true)
      expect(c.judgeCapable).toBe(true)
    }
  })

  it('includes non-routable providers when saasRoutableOnly is false', () => {
    const allChoices = judgeModelChoices({ saasRoutableOnly: false })
    const defaultChoices = judgeModelChoices()
    expect(allChoices.length).toBeGreaterThanOrEqual(defaultChoices.length)
  })

  it('filters to the requested providers', () => {
    const choices = judgeModelChoices({ providers: ['anthropic'], saasRoutableOnly: false })
    for (const c of choices) {
      expect(c.provider).toBe('anthropic')
    }
    expect(choices.length).toBeGreaterThan(0)
  })
})
