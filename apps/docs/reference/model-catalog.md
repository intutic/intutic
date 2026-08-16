# Model Catalog

Intutic ships a generated catalog of LLM models — which provider offers each one, its context
window, output token limit, per-1K token cost, and whether it's a reasonable fit for judging
another model's work. It's what powers the model picker under
[Settings → LLM Judge](/guide/settings#llm-judge) and the [cohort wizard](/guide/cohort-wizard),
and it's available directly from `@intutic/shared-types` for anything else you build against
Intutic's provider registry.

## Where it comes from

The catalog is generated from the same upstream source that prices every request this proxy
handles — LiteLLM's `model_prices_and_context_window.json` — via
`tools/scripts/build-offline-pricing-bundle.ts`. One fetch produces two files:

- `packages/proxy/src/pricing/offline_bundle.json` — compiled into the proxy binary, used for
  cost estimation.
- `packages/shared-types/src/modelCatalog.generated.ts` — the catalog this page documents.

Both are regenerated together, monthly, so a model's context window and its price can never
drift apart from disagreeing about which upstream snapshot they came from.

## Shape

```ts
interface ModelCatalogEntry {
  ref: string                  // canonical id: `${provider}/${id}`, e.g. "anthropic/claude-haiku-4-5"
  id: string                   // bare wire id, no provider prefix
  provider: string             // one of the provider registry's ids (see Provider Keys)
  displayName: string
  contextWindow?: number
  maxOutputTokens?: number
  inputCostPer1k?: number
  outputCostPer1k?: number
  supportsFunctionCalling: boolean
  supportsVision: boolean
  judgeCapable: boolean        // see "What makes a model judge-capable" below
  deprecated: boolean          // upstream's deprecation_date has passed
}
```

## Provider coverage

The catalog spans every provider in the registry (Anthropic, OpenAI, Gemini, Mistral,
OpenRouter, Azure OpenAI, AWS Bedrock, Google Vertex AI, Cohere, Ollama) — but "in the catalog"
and "routable by Intutic's managed gateway today" are different questions. Only
`routingLive: true` providers (Anthropic, OpenAI, Gemini, Mistral, OpenRouter as of this
writing — see [Provider Keys](/guide/settings#provider-keys)) can actually be reached through
the SaaS judge path; the rest are real, browsable catalog entries for providers whose *routing*
is separate, real engineering, not yet built. `judgeModelChoices({ saasRoutableOnly: true })`
(the default) filters to what's actually usable today; pass `false` to see the full catalog,
appropriate for an on-prem judge where a self-hosted LiteLLM deployment can serve anything.

## What makes a model judge-capable

`judgeCapable` is computed once, at generation time, from:

- `mode === 'chat'` (not an embedding, image, or audio model)
- no audio output
- at least 256 max output tokens
- at least an 8,192-token context window
- not deprecated

This is a floor a judge call can reasonably run under, not a quality ranking — a small,
fast, cheap model that clears the floor is `judgeCapable`, and whether it's a *good* judge is a
separate, workspace-specific decision.

## Using it in code

```ts
import { judgeModelChoices, findCatalogModel, normalizeModelRef } from '@intutic/shared-types'

// Models a workspace with provisioned Anthropic + OpenAI credentials could pick as a judge
const choices = judgeModelChoices({ providers: ['anthropic', 'openai'], saasRoutableOnly: true })

// Look up a model by its canonical ref or bare id
const entry = findCatalogModel('claude-haiku-4-5')

// Collapse an accidentally-repeated provider prefix
normalizeModelRef('anthropic/anthropic/claude-haiku-4-5')
// → { provider: 'anthropic', id: 'claude-haiku-4-5', ref: 'anthropic/claude-haiku-4-5' }
```

## Custom and BYO model names

A name outside the catalog is always legal — an on-prem LiteLLM deployment can serve any model
under any alias it chooses. Nothing that validates `managedJudgeModel` (the settings PUT, the
judge-model test route) checks catalog membership; it only checks the character shape. Catalog
membership is informational — the dashboard shows an amber **custom model** badge for a name it
doesn't recognize, never a validation error. See [the cohort wizard](/guide/cohort-wizard) and
[the on-prem judge](/external/on-prem-judge) for where this matters in practice.

## Related

- [Settings & Configuration — LLM Judge](/guide/settings#llm-judge)
- [The cohort wizard](/guide/cohort-wizard)
- [On-prem judge setup](/external/on-prem-judge)
- [Provider Keys](/guide/settings#provider-keys)
