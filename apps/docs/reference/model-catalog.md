# Model Catalog

Intutic ships a generated catalog of LLM models — which provider offers each one, its context
window, output token limit, per-1K token cost, and whether it's a reasonable fit for judging
another model's work. It's what powers the self-hosted model picker in
[`intutic judge configure`](/reference/cli#intutic-judge-configure), and it's available directly
from `@intutic/shared-types` for anything else you build against Intutic's provider registry.

## Where it comes from

The catalog is generated from the same upstream source that prices every request this proxy
handles — LiteLLM's `model_prices_and_context_window.json` — via
`tools/scripts/build-offline-pricing-bundle.ts`. One fetch produces two files:

- `packages/proxy/src/pricing/offline_bundle.json` — compiled into the proxy binary, used for
  cost estimation.
- `packages/shared-types/src/modelCatalog.generated.ts` — the catalog this page documents.

Both are regenerated together, nightly, so a model's context window and its price can never
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

The catalog spans the registry's providers (Anthropic, OpenAI, Gemini, Mistral,
OpenRouter, Azure OpenAI, AWS Bedrock, Google Vertex AI, Cohere, Ollama; not yet DeepSeek's own
API, whose models appear only under OpenRouter and Ollama) — but "in the catalog"
and "routable by Intutic's managed gateway today" are different questions. Only
`routingLive: true` providers (Anthropic, OpenAI, Gemini, Mistral, OpenRouter, DeepSeek as of this
writing — see [Provider Keys](/guide/settings#provider-keys)) can be reached through the
gateway; the rest are real, browsable catalog entries for providers whose *routing* is
separate, real engineering, not yet built.

Judges are a narrower question still: they run only on self-hosted models. Of the registry,
only Ollama is self-hosted (`SELF_HOSTED_MODEL_PROVIDER_IDS`), and its Ollama Cloud models
(`ollama/<name>:<size>-cloud`) run on ollama.com, so they count as hosted.
`selfHostedJudgeModelChoices()` returns the judge-capable entries left after that filter.

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
import {
  selfHostedJudgeModelChoices,
  isHostedModelRef,
  findCatalogModel,
  normalizeModelRef,
} from '@intutic/shared-types'

// Judge-capable models an on-prem judge may use (Ollama, Ollama Cloud excluded)
const choices = selfHostedJudgeModelChoices()

// Refuse a hosted judge model
isHostedModelRef('anthropic/claude-haiku-4-5') // → true
isHostedModelRef('ollama/gpt-oss:120b-cloud')  // → true (Ollama Cloud)
isHostedModelRef('ollama/llama3.1')            // → false
isHostedModelRef('my-org/local-qwen')          // → false (a local alias, not a registry provider)

// Look up a model by its canonical ref or bare id
const entry = findCatalogModel('claude-haiku-4-5')

// Collapse an accidentally-repeated provider prefix
normalizeModelRef('anthropic/anthropic/claude-haiku-4-5')
// → { provider: 'anthropic', id: 'claude-haiku-4-5', ref: 'anthropic/claude-haiku-4-5' }
```

## Custom and BYO model names

A name outside the catalog is legal — an on-prem LiteLLM deployment can serve any model under
any alias it chooses, and `intutic judge configure` accepts such a name with a warning. Catalog
membership is informational. What is refused is a hosted model: a custom judge reference for
which `isHostedModelRef()` is true. See [the on-prem judge](/external/on-prem-judge) for where
this matters in practice.

## Related

- [Settings & Configuration — Judges](/guide/settings#judges)
- [On-prem judge setup](/external/on-prem-judge)
- [Provider Keys](/guide/settings#provider-keys)
