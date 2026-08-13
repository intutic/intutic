/**
 * Multi-provider credential registry (LLD #67, multi-provider key wizard).
 *
 * `services/control-plane/src/routes/providerCredentials.ts` originally
 * hardcoded exactly 3 providers (anthropic/openai/gemini), each a single
 * bearer API key — sufficient for those three, but LiteLLM's real provider
 * surface includes providers needing MULTIPLE credential fields (Azure
 * OpenAI: endpoint + deployment + key; Bedrock: AWS region + access key +
 * secret; Vertex AI: a service-account JSON blob). This registry is a
 * data-driven description of a provider's credential shape, so adding a
 * new provider's *field layout* is a data change here, not new code in
 * every place that touches credentials.
 *
 * Deliberately NOT exhaustive — LiteLLM supports 100+ providers. This is a
 * representative slice spanning the shapes that actually differ (single
 * key, multi-field cloud credential, self-hosted endpoint, structured
 * blob), chosen so the registry's own shape is proven out before claiming
 * to cover the full LiteLLM catalog. Adding another provider that fits one
 * of these shapes is adding one entry, not new plumbing.
 *
 * `routingLive: true` means `packages/proxy` actually forwards requests to
 * this provider today (`fetch_provider_credential` in `proxy.rs` knows its
 * field name). `routingLive: false` means the credential can be
 * pre-provisioned here, but nothing in the proxy calls it yet — routing
 * support is separate, real per-provider engineering (a new `Provider`
 * enum variant, `get_model_provider`, pricing in `pricing.rs`), not a
 * config change. The dashboard wizard must say so, not imply the key is
 * live the moment it's saved.
 *
 * @module
 */

/** How a single credential field should render in a form. */
export type ProviderFieldType = 'text' | 'password' | 'textarea'

export interface ProviderCredentialField {
  /** Storage key within the provider's config blob, e.g. 'apiKey', 'awsRegion'. */
  key: string
  label: string
  type: ProviderFieldType
  required: boolean
  placeholder?: string
  helpText?: string
}

export interface ProviderDefinition {
  /** Stable id — also the Valkey field/hash-key prefix. */
  id: string
  displayName: string
  /** Link to the provider's own API-key docs, shown in the wizard. */
  docsUrl?: string
  fields: ProviderCredentialField[]
  /** See module doc — whether packages/proxy currently routes to this provider. */
  routingLive: boolean
}

/**
 * The 3 providers this system supported before this registry existed —
 * their storage format (`{provider}_api_key`, a flat string field) is
 * unchanged here, matching what `packages/proxy/src/proxy.rs`'s
 * `fetch_provider_credential` has always read for them.
 *
 * NOT the same question as a provider's `routingLive` flag. This constant
 * decides *storage shape* (flat field vs. `{provider}_config` JSON blob);
 * `routingLive` decides whether the proxy currently forwards requests to a
 * provider at all. They agreed for exactly these 3 while this registry only
 * covered its original scope, but multi-provider wizard phase 3 added real
 * proxy routing for Mistral and OpenRouter *without* changing their storage
 * format — `fetch_provider_credential` reads the JSON blob for both, never
 * the flat field, so they stay off this list even though `routingLive` is
 * now `true` for them. Adding a provider here changes what Valkey field
 * `services/control-plane/src/routes/providerCredentials.ts` writes to —
 * only do it alongside the matching proxy-side flat-field read, never for
 * the "is this provider live" reason alone.
 */
export const LIVE_ROUTING_PROVIDER_IDS = ['anthropic', 'openai', 'gemini'] as const

export const PROVIDER_REGISTRY: ProviderDefinition[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    fields: [{ key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'sk-ant-...' }],
    routingLive: true,
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    docsUrl: 'https://platform.openai.com/api-keys',
    fields: [{ key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'sk-...' }],
    routingLive: true,
  },
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    fields: [{ key: 'apiKey', label: 'API Key', type: 'password', required: true }],
    routingLive: true,
  },
  {
    id: 'azure_openai',
    displayName: 'Azure OpenAI',
    docsUrl: 'https://learn.microsoft.com/azure/ai-services/openai/how-to/create-resource',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', required: true },
      { key: 'endpoint', label: 'Resource Endpoint', type: 'text', required: true, placeholder: 'https://your-resource.openai.azure.com' },
      { key: 'deploymentName', label: 'Deployment Name', type: 'text', required: true },
    ],
    routingLive: false,
  },
  {
    id: 'bedrock',
    displayName: 'AWS Bedrock',
    docsUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html',
    fields: [
      { key: 'awsAccessKeyId', label: 'AWS Access Key ID', type: 'password', required: true },
      { key: 'awsSecretAccessKey', label: 'AWS Secret Access Key', type: 'password', required: true },
      { key: 'awsRegion', label: 'AWS Region', type: 'text', required: true, placeholder: 'us-east-1' },
    ],
    routingLive: false,
  },
  {
    id: 'vertex_ai',
    displayName: 'Google Vertex AI',
    docsUrl: 'https://cloud.google.com/vertex-ai/docs/authentication',
    fields: [
      { key: 'projectId', label: 'GCP Project ID', type: 'text', required: true },
      { key: 'serviceAccountJson', label: 'Service Account JSON', type: 'textarea', required: true, helpText: 'The full JSON key file contents for a service account with Vertex AI access.' },
    ],
    routingLive: false,
  },
  {
    id: 'cohere',
    displayName: 'Cohere',
    docsUrl: 'https://dashboard.cohere.com/api-keys',
    fields: [{ key: 'apiKey', label: 'API Key', type: 'password', required: true }],
    routingLive: false,
  },
  {
    id: 'mistral',
    displayName: 'Mistral AI',
    docsUrl: 'https://console.mistral.ai/api-keys',
    fields: [{ key: 'apiKey', label: 'API Key', type: 'password', required: true }],
    routingLive: true,
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    docsUrl: 'https://openrouter.ai/keys',
    fields: [{ key: 'apiKey', label: 'API Key', type: 'password', required: true }],
    routingLive: true,
  },
  {
    id: 'ollama',
    displayName: 'Ollama (self-hosted)',
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/api.md',
    fields: [{ key: 'apiBase', label: 'Server URL', type: 'text', required: true, placeholder: 'http://localhost:11434' }],
    routingLive: false,
  },
]

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
  return PROVIDER_REGISTRY.find((p) => p.id === id)
}

export function isKnownProviderId(id: string): boolean {
  return PROVIDER_REGISTRY.some((p) => p.id === id)
}

/**
 * Which provider the data-plane proxy would route a model name to.
 *
 * A hand-maintained TS mirror of `get_model_provider` in
 * `packages/proxy/src/proxy.rs` — the proxy's routing decision is the ground
 * truth, and this exists so the control plane / dashboard can predict it
 * (e.g. the BYO judge model "Test" flow fast-failing on an unprovisioned
 * provider before making a real call, LLD #70). A parity unit test pins this
 * against the Rust source; if the heuristic changes there, change it here in
 * the same commit.
 *
 * Order matters and matches the Rust exactly: claude → gemini → '/'
 * (OpenRouter's vendor/model namespacing — checked before the mistral
 * prefixes so "mistralai/..." routes to OpenRouter) → mistral prefixes →
 * OpenAI as the default arm.
 */
export function inferProviderForModel(
  model: string,
): 'anthropic' | 'gemini' | 'openrouter' | 'mistral' | 'openai' {
  const m = model.toLowerCase()
  if (m.includes('claude')) return 'anthropic'
  if (m.includes('gemini')) return 'gemini'
  if (m.includes('/')) return 'openrouter'
  if (m.startsWith('mistral') || m.startsWith('open-mixtral') || m.startsWith('codestral')) {
    return 'mistral'
  }
  return 'openai'
}
