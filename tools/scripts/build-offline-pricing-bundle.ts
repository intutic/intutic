#!/usr/bin/env tsx
/**
 * Offline Pricing Bundle Builder
 *
 * Fetches the latest LiteLLM model_prices_and_context_window.json and extracts
 * a curated subset into packages/proxy/src/pricing/offline_bundle.json.
 *
 * As of LLD #70, the SAME fetch also emits
 * packages/shared-types/src/modelCatalog.generated.ts — the model catalog behind
 * the judge-model picker and the cohort wizard. One fetch, two artifacts, so the
 * two can never drift against each other by being regenerated at different times.
 *
 * Run nightly by .github/workflows/pricing-repin.yml (tools/scripts/pricing-repin.sh),
 * which re-pins LITELLM_PRICES_SHA below and merges the result on green CI.
 * By hand: pnpm --filter @intutic/cli exec tsx "$PWD/tools/scripts/build-offline-pricing-bundle.ts"
 *
 * The generated bundle is then baked into the proxy binary at build time via:
 *   include_str!("pricing/offline_bundle.json")
 *
 * LLD §31 WS-5OP — TD-130 graduation
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Pinned to a commit, not the mutable `main` branch — this file's own output
// gets baked straight into the proxy binary and interpolated into generated
// TypeScript source (see contextWindow/maxOutputTokens below), so an upstream
// push landing between a review and the next scheduled run would otherwise
// ship unreviewed. The nightly re-pin (pricing-repin.sh) moves it to LiteLLM's
// last commit before 00:00 UTC; its review (pricing-repin-review.mjs) holds a
// change that drops a priced model or zeroes a rate for a person.
const LITELLM_PRICES_SHA = 'e638540de943eddb66f2fd543bfc75210d9c4b77' // 2026-10-08
const LITELLM_PRICES_URL = `https://raw.githubusercontent.com/BerriAI/litellm/${LITELLM_PRICES_SHA}/model_prices_and_context_window.json`

const OUTPUT_PATH = resolve(
  import.meta.dirname ?? __dirname,
  '../../packages/proxy/src/pricing/offline_bundle.json',
)

const CATALOG_OUTPUT_PATH = resolve(
  import.meta.dirname ?? __dirname,
  '../../packages/shared-types/src/modelCatalog.generated.ts',
)

// ─── Models to include in the offline bundle ─────────────────────────────────
// Keep this list curated — too large bloats binary size, too small misses coverage.
const INCLUDED_PREFIXES = [
  'claude',
  'gpt-4',
  'gpt-3.5',
  'o1',
  'o3',
  'o4',
  'gemini',
  'mistral',
  'codestral',
  'llama-3',
  'deepseek',
]

// Models the prefix list would admit but that are not text models, however
// upstream labels them. LiteLLM marks Google's Lyria music models `mode: chat`
// with a zero per-token price (they are billed per generated clip), and a
// zero-rate chat model in the bundle makes the budget gate inert for it —
// `pricingParity.test.ts` refuses exactly that. Excluded here rather than
// allow-listed as "free", because they are neither free nor routable by this
// proxy.
const EXCLUDED_MODEL_PATTERNS: RegExp[] = [/(^|\/)lyria[-\d.]*/i]

// ─── Family fallback definitions ─────────────────────────────────────────────
// Manually curated prefix fallbacks for unknown model version aliases.
const FAMILY_FALLBACKS: Record<string, { input_cost_per_1k: number; output_cost_per_1k: number }> = {
  'claude-opus':   { input_cost_per_1k: 0.015, output_cost_per_1k: 0.075 },
  'claude-sonnet': { input_cost_per_1k: 0.003, output_cost_per_1k: 0.015 },
  'claude-haiku':  { input_cost_per_1k: 0.0008, output_cost_per_1k: 0.004 },
  'claude':        { input_cost_per_1k: 0.003,  output_cost_per_1k: 0.015 },
  'gpt-4o':        { input_cost_per_1k: 0.0025, output_cost_per_1k: 0.01 },
  'gpt-4':         { input_cost_per_1k: 0.01,   output_cost_per_1k: 0.03 },
  'gpt-3.5':       { input_cost_per_1k: 0.0005, output_cost_per_1k: 0.0015 },
  'gpt':           { input_cost_per_1k: 0.0025, output_cost_per_1k: 0.01 },
  'o1':            { input_cost_per_1k: 0.015,  output_cost_per_1k: 0.06 },
  'o3':            { input_cost_per_1k: 0.010,  output_cost_per_1k: 0.040 },
  'o4':            { input_cost_per_1k: 0.0011, output_cost_per_1k: 0.0044 },
  'gemini-2.5':    { input_cost_per_1k: 0.00125, output_cost_per_1k: 0.005 },
  'gemini-2':      { input_cost_per_1k: 0.0001,  output_cost_per_1k: 0.0004 },
  'gemini-1.5':    { input_cost_per_1k: 0.00125, output_cost_per_1k: 0.005 },
  'gemini':        { input_cost_per_1k: 0.00125, output_cost_per_1k: 0.005 },
  'mistral':       { input_cost_per_1k: 0.003,  output_cost_per_1k: 0.009 },
  'llama':         { input_cost_per_1k: 0.00065, output_cost_per_1k: 0.00065 },
  'deepseek':      { input_cost_per_1k: 0.00027, output_cost_per_1k: 0.0011 },
}

// ─── Model catalog (LLD #70) ──────────────────────────────────────────────────
// Separate from the pricing bundle above: the bundle prices by family-prefix
// match across ALL providers combined (it only ever needs "close enough" for an
// unknown model-name variant); the catalog is per-provider and per-model, feeding
// a picker that needs to say "these are Anthropic's chat models" specifically.
//
// LiteLLM's own `litellm_provider` field maps onto our registry's 10 provider
// ids (packages/shared-types/src/providers.ts). Anything not in this map is
// outside PROVIDER_REGISTRY and dropped from the catalog — same posture as the
// pricing bundle's own prefix filter above.
const LITELLM_PROVIDER_MAP: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'gemini',
  'vertex_ai-language-models': 'vertex_ai',
  'vertex_ai-chat-models': 'vertex_ai',
  azure: 'azure_openai',
  bedrock: 'bedrock',
  bedrock_converse: 'bedrock',
  mistral: 'mistral',
  openrouter: 'openrouter',
  cohere: 'cohere',
  cohere_chat: 'cohere',
  ollama: 'ollama',
  ollama_chat: 'ollama',
}

// Some upstream keys carry a redundant leading segment that just repeats the
// litellm_provider value (`gemini/gemini-2.0-flash`, `azure/gpt-4o`) — our
// `id` is meant to be the bare wire id a request would actually send, with the
// provider expressed once via `ref`'s own prefix, not twice. Verified against a
// live fetch per provider before writing this table — not every provider does
// this (bedrock_converse, vertex_ai, and cohere_chat's keys are already bare;
// openrouter's `vendor/model` tail is real model identity, not a repeat, so only
// its own wrapper prefix is stripped, not the vendor segment after it).
const CATALOG_KEY_STRIP_PREFIX: Record<string, string> = {
  gemini: 'gemini/',
  azure: 'azure/',
  mistral: 'mistral/',
  ollama: 'ollama/',
  ollama_chat: 'ollama/',
  openrouter: 'openrouter/',
}

// Curated per-provider inclusion, same "keep this list curated" philosophy as
// INCLUDED_PREFIXES above — a provider's raw chat-model listing runs from a
// handful (Anthropic) to several hundred (OpenRouter re-exporting everyone
// else's models); an unfiltered catalog would be dominated by long tails of
// regional Bedrock ARNs and dated preview variants nobody picks from a list.
// OpenRouter is filtered against its `vendor/model` tail matching one of these
// same family prefixes, since it re-exports models already covered elsewhere.
// Keyed by our provider id (post-LITELLM_PROVIDER_MAP), not litellm_provider —
// e.g. 'azure_openai', not 'azure'. A key here that doesn't match a mapped
// provider id silently filters that provider's catalog to zero, so this must
// stay in exact lockstep with LITELLM_PROVIDER_MAP's values.
const CATALOG_PROVIDER_PREFIXES: Record<string, string[]> = {
  anthropic: ['claude'],
  openai: ['gpt-4', 'gpt-3.5', 'o1', 'o3', 'o4'],
  gemini: ['gemini'],
  vertex_ai: ['gemini'],
  azure_openai: ['gpt-4', 'gpt-3.5', 'o1', 'o3', 'o4'],
  bedrock: ['claude', 'llama', 'nova', 'mistral'],
  mistral: ['mistral', 'codestral', 'open-mixtral', 'devstral'],
  cohere: ['command-r', 'command-a', 'command-light'],
  ollama: ['llama', 'qwen', 'deepseek', 'mistral', 'codestral', 'gpt-oss'],
  openrouter: INCLUDED_PREFIXES,
}

// Bedrock ids carry an AWS cross-region-inference prefix (`us.`, `apac.`,
// `eu.`, `global.`) ahead of the real model id — same underlying model,
// several regional SKUs. Stripped so the catalog shows one entry per model
// rather than one per region; byRef's Map naturally dedupes the collapse.
const BEDROCK_REGION_PREFIX = /^(us|eu|apac|ap|global)\./

interface ModelCatalogEntryData {
  ref: string
  id: string
  provider: string
  displayName: string
  contextWindow?: number
  maxOutputTokens?: number
  inputCostPer1k?: number
  outputCostPer1k?: number
  supportsFunctionCalling: boolean
  supportsVision: boolean
  judgeCapable: boolean
  deprecated: boolean
}

function stripCatalogPrefix(litellmProvider: string, key: string): string {
  const prefix = CATALOG_KEY_STRIP_PREFIX[litellmProvider]
  const stripped = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key
  if (litellmProvider === 'bedrock' || litellmProvider === 'bedrock_converse') {
    return stripped.replace(BEDROCK_REGION_PREFIX, '')
  }
  return stripped
}

function matchesCatalogPrefix(providerId: string, bareId: string): boolean {
  const prefixes = CATALOG_PROVIDER_PREFIXES[providerId]
  if (!prefixes) return false
  const lower = bareId.toLowerCase()
  // OpenRouter's id is `vendor/model` — match against the model segment, not the
  // vendor name, so `anthropic/claude-3-haiku` matches on `claude`.
  const tail = providerId === 'openrouter' && lower.includes('/') ? lower.slice(lower.indexOf('/') + 1) : lower
  return prefixes.some((p) => tail.includes(p))
}

function buildModelCatalog(
  raw: Record<string, any>,
  generatedAt: string,
): ModelCatalogEntryData[] {
  const byRef = new Map<string, ModelCatalogEntryData>()

  for (const [key, data] of Object.entries(raw)) {
    if (key === 'sample_spec') continue
    if (EXCLUDED_MODEL_PATTERNS.some(re => re.test(key.toLowerCase()))) continue
    if (data.mode !== 'chat') continue

    const litellmProvider = String(data.litellm_provider ?? '')
    const providerId = LITELLM_PROVIDER_MAP[litellmProvider]
    if (!providerId) continue

    const id = stripCatalogPrefix(litellmProvider, key)
    if (!matchesCatalogPrefix(providerId, id)) continue

    // A future-dated deprecation_date is a heads-up, not an exclusion; only a
    // date already passed means the model is actually gone.
    const deprecated = typeof data.deprecation_date === 'string' && data.deprecation_date <= generatedAt

    const input = data.input_cost_per_token
    const output = data.output_cost_per_token
    const inputCostPer1k = typeof input === 'number' ? +(input * 1000).toFixed(8) : undefined
    const outputCostPer1k = typeof output === 'number' ? +(output * 1000).toFixed(8) : undefined

    // Validated the same way inputCostPer1k/outputCostPer1k already are below —
    // these two flow into serializeCatalogEntry's template-literal interpolation
    // UNQUOTED (`contextWindow: ${e.contextWindow}`), because they are meant to
    // compile as numeric literals in the generated TypeScript. Anything upstream
    // sends that is not actually a finite number — a string, null, NaN — would
    // otherwise be spliced verbatim into that generated source.
    const rawContextWindow = data.max_input_tokens ?? data.max_tokens
    const rawMaxOutputTokens = data.max_output_tokens ?? data.max_tokens
    const contextWindow: number | undefined =
      typeof rawContextWindow === 'number' && Number.isFinite(rawContextWindow) ? rawContextWindow : undefined
    const maxOutputTokens: number | undefined =
      typeof rawMaxOutputTokens === 'number' && Number.isFinite(rawMaxOutputTokens) ? rawMaxOutputTokens : undefined
    const supportsFunctionCalling = data.supports_function_calling === true
    const supportsVision = data.supports_vision === true
    const supportsAudioOutput = data.supports_audio_output === true

    const judgeCapable =
      !deprecated &&
      !supportsAudioOutput &&
      (maxOutputTokens ?? 0) >= 256 &&
      (contextWindow ?? 0) >= 8192

    const ref = `${providerId}/${id}`
    const entry: ModelCatalogEntryData = {
      ref,
      id,
      provider: providerId,
      displayName: id,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(inputCostPer1k !== undefined ? { inputCostPer1k } : {}),
      ...(outputCostPer1k !== undefined ? { outputCostPer1k } : {}),
      supportsFunctionCalling,
      supportsVision,
      judgeCapable,
      deprecated,
    }
    // Later entries for the same ref (a second key stripping to the same bare
    // id) overwrite earlier ones — acceptable, since this catalog is a picker
    // aid, not a billing source; the pricing bundle above is the priced source
    // of truth and is unaffected by this loop.
    byRef.set(ref, entry)
  }

  return Array.from(byRef.values()).sort((a, b) => a.ref.localeCompare(b.ref))
}

function serializeCatalogEntry(e: ModelCatalogEntryData): string {
  const fields = [
    `ref: ${JSON.stringify(e.ref)}`,
    `id: ${JSON.stringify(e.id)}`,
    `provider: ${JSON.stringify(e.provider)}`,
    `displayName: ${JSON.stringify(e.displayName)}`,
    ...(e.contextWindow !== undefined ? [`contextWindow: ${e.contextWindow}`] : []),
    ...(e.maxOutputTokens !== undefined ? [`maxOutputTokens: ${e.maxOutputTokens}`] : []),
    ...(e.inputCostPer1k !== undefined ? [`inputCostPer1k: ${e.inputCostPer1k}`] : []),
    ...(e.outputCostPer1k !== undefined ? [`outputCostPer1k: ${e.outputCostPer1k}`] : []),
    `supportsFunctionCalling: ${e.supportsFunctionCalling}`,
    `supportsVision: ${e.supportsVision}`,
    `judgeCapable: ${e.judgeCapable}`,
    `deprecated: ${e.deprecated}`,
  ]
  return `  { ${fields.join(', ')} },`
}

function writeModelCatalog(entries: ModelCatalogEntryData[], generatedAt: string) {
  const lines = [
    '// GENERATED — do not edit by hand.',
    '//',
    '// Regenerate with tools/scripts/build-offline-pricing-bundle.ts (enterprise repo) —',
    '// the same fetch that produces packages/proxy/src/pricing/offline_bundle.json.',
    `// Source: ${LITELLM_PRICES_URL}`,
    `// Generated: ${generatedAt}`,
    '//',
    '// See packages/shared-types/src/modelCatalog.ts for the ModelCatalogEntry type',
    '// and the helpers (findCatalogModel, normalizeModelRef, selfHostedJudgeModelChoices) that',
    '// consume this data. LLD #70.',
    '',
    'export const MODEL_CATALOG_GENERATED = [',
    ...entries.map(serializeCatalogEntry),
    '] as const',
    '',
  ]
  writeFileSync(CATALOG_OUTPUT_PATH, lines.join('\n'), 'utf-8')
  console.log(`  Written to ${CATALOG_OUTPUT_PATH}`)
  console.log(`  Catalog entries: ${entries.length}`)
}

// ─── Fetch and transform ───────────────────────────────────────────────────────
async function main() {
  console.log(`Fetching LiteLLM prices from ${LITELLM_PRICES_URL}...`)

  const resp = await fetch(LITELLM_PRICES_URL, { signal: AbortSignal.timeout(30000) })
  if (!resp.ok) {
    throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`)
  }

  const raw = await resp.json() as Record<string, any>
  console.log(`  Fetched ${Object.keys(raw).length} model entries from LiteLLM`)

  const models: Record<
    string,
    {
      input_cost_per_1k: number
      output_cost_per_1k: number
      max_tokens?: number
      cache_read_cost_per_1k?: number
      cache_write_cost_per_1k?: number
    }
  > = {}
  let included = 0
  let skipped = 0

  for (const [name, data] of Object.entries(raw)) {
    if (name === 'sample_spec') { skipped++; continue }

    // Include only models matching our curated prefix list
    const lower = name.toLowerCase()
    const matches = INCLUDED_PREFIXES.some(prefix => lower.startsWith(prefix))
      && !EXCLUDED_MODEL_PATTERNS.some(re => re.test(lower))
    if (!matches) { skipped++; continue }

    // Embedding and reranker models have no output tokens, so upstream omits an
    // output cost entirely. Including them wrote `output_cost_per_1k: 0` into the
    // bundle, which is indistinguishable from "this model's output is free" — the
    // one value that makes a budget gate silently unenforceable. They are also not
    // what this proxy prices: it costs chat completions. Skip at the source rather
    // than special-casing a zero downstream.
    if (data.mode && data.mode !== 'chat' && data.mode !== 'completion') { skipped++; continue }

    // Must have at least input cost
    const input = data.input_cost_per_token ?? data.input_cost_per_1k_tokens
    const output = data.output_cost_per_token ?? data.output_cost_per_1k_tokens

    if (typeof input !== 'number') { skipped++; continue }
    // Input but no output cost cannot price a completion. Recording 0 would
    // under-bill every call; omitting the entry lets the conservative unknown-model
    // estimate apply, which errs in the safe direction.
    if (typeof output !== 'number') { skipped++; continue }

    // LiteLLM stores cost per token, we store cost per 1K tokens
    const isPerToken = data.input_cost_per_token !== undefined
    const multiplier = isPerToken ? 1000 : 1

    // Prompt-caching rates. Not every model has these — only a minority of
    // providers (Anthropic chief among them) charge separately for a cache
    // read vs. a cache write, and LiteLLM only publishes the two fields when
    // the provider does. Same "omit rather than zero" discipline as output
    // cost above: a missing cache rate must fall through to full input-price
    // billing (see TD-347), not silently read as "caching is free here".
    const cacheRead = data.cache_read_input_token_cost
    const cacheWrite = data.cache_creation_input_token_cost

    models[lower] = {
      input_cost_per_1k:  +(( (input  ?? 0) * multiplier ).toFixed(8)),
      output_cost_per_1k: +(( (output ?? 0) * multiplier ).toFixed(8)),
      ...(data.max_tokens ? { max_tokens: data.max_tokens } : {}),
      ...(typeof cacheRead === 'number'
        ? { cache_read_cost_per_1k: +(cacheRead * 1000).toFixed(8) }
        : {}),
      ...(typeof cacheWrite === 'number'
        ? { cache_write_cost_per_1k: +(cacheWrite * 1000).toFixed(8) }
        : {}),
    }
    included++
  }

  console.log(`  Included: ${included} models | Skipped: ${skipped}`)

  // ─── Carry forward models upstream has delisted ──────────────────────────────
  //
  // Upstream prunes entries for models it considers superseded — a 2026-08-01 run
  // dropped 23 of ours, including `claude-3-5-sonnet`, which is named in this
  // product's own proxy-config.yaml model_list.
  //
  // Delisted upstream does not mean unreachable. A provider keeps serving a model
  // long after an aggregator stops tracking it, and a request naming one still has
  // to be priced. Dropping the entry does not fail loudly: the lookup falls through
  // to a family prefix and returns a plausible number for a different model. That is
  // exactly TD-COST-002 — claude-haiku-4-5 missing from this bundle resolved to
  // claude-3-5-haiku and priced every call at 80% of true cost, silently.
  //
  // So a regeneration is additive for rates and never subtractive for coverage. An
  // entry only leaves this bundle when a human deletes it, having established the
  // model is genuinely gone.
  let carried = 0
  try {
    const prev = JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8')) as {
      models?: Record<
        string,
        {
          input_cost_per_1k: number
          output_cost_per_1k: number
          max_tokens?: number
          cache_read_cost_per_1k?: number
          cache_write_cost_per_1k?: number
        }
      >
    }
    // Carrying the whole `rate` object wholesale (not field-by-field) already
    // preserves cache_read_cost_per_1k/cache_write_cost_per_1k on a carried
    // model along with input/output — no separate per-field carry needed.
    for (const [name, rate] of Object.entries(prev.models ?? {})) {
      // A model excluded on purpose above must not sneak back in from the
      // previous bundle, or an exclusion could never take effect.
      if (EXCLUDED_MODEL_PATTERNS.some(re => re.test(name.toLowerCase()))) continue
      if (!models[name]) {
        models[name] = rate
        carried++
      }
    }
    if (carried > 0) {
      console.log(`  Carried forward: ${carried} model(s) upstream no longer lists`)
    }
  } catch {
    // First run, or the bundle is absent — nothing to carry.
  }

  const bundle = {
    _meta: {
      source: LITELLM_PRICES_URL,
      generated_at: new Date().toISOString().slice(0, 10),
      refresh_script: 'tools/scripts/build-offline-pricing-bundle.ts',
      note:
        'Baked into the proxy binary via include_str!(), so editing this file does ' +
        'nothing until the image is rebuilt. Regenerate with ' +
        'tools/scripts/build-offline-pricing-bundle.ts; drift against published rates ' +
        'is reported monthly by .github/workflows/pricing-drift.yml. Override with ' +
        'OFFLINE_PRICING_PATH.',
    },
    models,
    family_fallbacks: FAMILY_FALLBACKS,
    unknown_model_conservative_estimate: {
      input_cost_per_1k:  0.015,
      output_cost_per_1k: 0.060,
      note: 'Conservative Opus-class estimate. Logs WARN. Avoids silent $0 underbilling for unrecognized models.',
    },
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(bundle, null, 2) + '\n', 'utf-8')
  console.log(`  Written to ${OUTPUT_PATH}`)
  console.log(`  Bundle size: ${(JSON.stringify(bundle).length / 1024).toFixed(1)} KB`)

  const generatedAt = bundle._meta.generated_at
  const catalog = buildModelCatalog(raw, generatedAt)
  writeModelCatalog(catalog, generatedAt)

  console.log('Done! Commit packages/proxy/src/pricing/offline_bundle.json')
  console.log('  and packages/shared-types/src/modelCatalog.generated.ts.')
}

main().catch(err => {
  console.error('Build failed:', err)
  process.exit(1)
})
