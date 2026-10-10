/**
 * Model catalog (model catalog & cohort wizard).
 *
 * `packages/shared-types/src/providers.ts` describes what a provider's
 * CREDENTIAL looks like — field names, types, docs URL. It says nothing about
 * what MODELS a provider offers, because that's a different lifecycle: the
 * provider registry is ~10 hand-curated, rarely-changing entries; the model
 * catalog is ~500 generated entries that churn monthly as upstream pricing
 * data refreshes. Conflating them would force every catalog regen to touch
 * the file `check-public-parity.js` and reviewers treat as a stable,
 * hand-reviewed credential surface.
 *
 * The actual data lives in `modelCatalog.generated.ts` — regenerate it with
 * `tools/scripts/build-offline-pricing-bundle.ts` (enterprise repo only; the
 * same fetch that produces `packages/proxy/src/pricing/offline_bundle.json`,
 * so the two can never drift from being regenerated at different times).
 * This file is the hand-written, stable surface: types and query helpers.
 *
 * @module
 */

import { MODEL_CATALOG_GENERATED } from './modelCatalog.generated.js'
import { PROVIDER_REGISTRY } from './providers.js'

export interface ModelCatalogEntry {
  /** Canonical id, exactly one provider prefix: `${provider}/${id}`. */
  ref: string
  /** Bare wire id — what a request actually sends as the model name. */
  id: string
  /** One of PROVIDER_REGISTRY's ids (`providers.ts`). */
  provider: string
  displayName: string
  contextWindow?: number
  maxOutputTokens?: number
  inputCostPer1k?: number
  outputCostPer1k?: number
  supportsFunctionCalling: boolean
  supportsVision: boolean
  /**
   * Chat-mode, not audio-output, at least 256 max output tokens and an 8k+
   * context window — a floor a judge call can reasonably run under. Computed
   * once at generation time (see the generator's `judgeCapable` derivation)
   * rather than recomputed per query, so this field and the predicate that
   * produced it can never disagree.
   */
  judgeCapable: boolean
  /** Upstream's `deprecation_date` has passed as of generation time. */
  deprecated: boolean
}

/** The full generated catalog, typed. */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = MODEL_CATALOG_GENERATED

/**
 * Collapse an accidental repeated provider prefix down to one.
 *
 * A model ref should carry its provider exactly once — `anthropic/claude-...`,
 * not `anthropic/anthropic/claude-...`. Concatenating a stored provider id
 * with a model id that already carries the same prefix (e.g. a value copied
 * from a `ProviderKeyWizard` field, or a bare catalog `id` re-prefixed by a
 * caller that doesn't know it already has one) is exactly how that duplicate
 * shows up — a scar worth avoiding by normalizing at read time rather than
 * trusting every caller to pass a clean value.
 */
export function normalizeModelRef(input: string): { provider?: string; id: string; ref?: string } {
  const trimmed = input.trim()
  if (!trimmed) return { id: '' }

  const firstSlash = trimmed.indexOf('/')
  if (firstSlash === -1) {
    return { id: trimmed }
  }

  const provider = trimmed.slice(0, firstSlash)
  let rest = trimmed.slice(firstSlash + 1)

  // Collapse repeats of the SAME provider segment — `openai/openai/gpt-4o`
  // becomes `openai/gpt-4o`, but `openrouter/anthropic/claude-3-haiku` is
  // left alone: `anthropic` there is OpenRouter's vendor segment, a real
  // part of the model's identity, not a repeated provider prefix.
  while (rest.startsWith(`${provider}/`)) {
    rest = rest.slice(provider.length + 1)
  }

  return { provider, id: rest, ref: `${provider}/${rest}` }
}

/**
 * Look up a catalog entry by its canonical ref (`anthropic/claude-...`) or by
 * a bare id, trying every provider. A bare id is ambiguous across providers
 * in principle, but in practice model ids rarely collide across the 10
 * registry providers — the first match wins, and a caller that knows the
 * provider should pass the full ref instead.
 */
export function findCatalogModel(input: string): ModelCatalogEntry | undefined {
  const normalized = normalizeModelRef(input)
  if (normalized.ref) {
    const byRef = MODEL_CATALOG.find((e) => e.ref === normalized.ref)
    if (byRef) return byRef
  }
  return MODEL_CATALOG.find((e) => e.id === normalized.id || e.ref === input)
}

/**
 * Providers whose models run on infrastructure the operator controls. Every
 * other registry provider is a hosted API. Judges are self-hosted only (owner
 * rule, 2026-10-03), so these are the only providers a judge model
 * may come from.
 */
export const SELF_HOSTED_MODEL_PROVIDER_IDS: ReadonlySet<string> = new Set(['ollama'])

/**
 * Ollama Cloud models (`ollama/<name>:<size>-cloud`) carry the self-hosted
 * provider's prefix but run on ollama.com, so they are hosted too.
 */
const isOllamaCloudId = (id: string): boolean => id.endsWith('-cloud')

/**
 * True when `ref` names a hosted model: a registry provider prefix other than
 * a self-hosted one, or an Ollama Cloud model. A bare alias (`my-local-qwen`)
 * or an unknown prefix is not hosted by this test: it is whatever the
 * operator's own LiteLLM serves under that name.
 */
export function isHostedModelRef(ref: string): boolean {
  const { provider, id } = normalizeModelRef(ref)
  if (!provider) return false
  if (SELF_HOSTED_MODEL_PROVIDER_IDS.has(provider)) return isOllamaCloudId(id)
  return PROVIDER_REGISTRY.some((p) => p.id === provider)
}

/**
 * The catalog models an on-prem judge picker may offer (`intutic judge
 * configure`): judge-capable entries from self-hosted providers, Ollama Cloud
 * excluded. There is no hosted judge choice anywhere (owner rule,
 * 2026-10-03), so this replaced `judgeModelChoices`.
 */
export function selfHostedJudgeModelChoices(): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((e) => e.judgeCapable && !isHostedModelRef(e.ref))
}
