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
 * AWS Bedrock, Google Vertex AI and Azure OpenAI are routed by the proxy's
 * `src/cloud` module: requests name them as `bedrock/<model id>`,
 * `vertex/<model>` and `azure/<deployment>`, and the stored blob is the
 * region/endpoint plus credential that module signs or authenticates with.
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
  /**
   * Alternative credential sets, at least one of which must be complete —
   * e.g. Bedrock takes an access key pair OR a Bedrock API key. Each inner
   * list names field keys that are required together. Fields named here
   * are `required: false` individually.
   */
  requiresOneOf?: string[][]
  /** Shown above the fields: how requests name this provider's models. */
  usageHint?: string
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
    docsUrl: 'https://learn.microsoft.com/azure/ai-foundry/openai/how-to/create-resource',
    fields: [
      {
        key: 'endpoint',
        label: 'Resource Endpoint',
        type: 'text',
        required: true,
        placeholder: 'https://your-resource.openai.azure.com',
        helpText: 'An *.openai.azure.com, *.services.ai.azure.com or *.cognitiveservices.azure.com resource URL.',
      },
      { key: 'apiKey', label: 'API Key', type: 'password', required: true },
    ],
    usageHint: 'Name a deployment as azure/<deployment> in the model field.',
    routingLive: true,
  },
  {
    id: 'bedrock',
    displayName: 'AWS Bedrock',
    docsUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html',
    fields: [
      { key: 'awsRegion', label: 'AWS Region', type: 'text', required: true, placeholder: 'us-east-1' },
      { key: 'awsAccessKeyId', label: 'AWS Access Key ID', type: 'password', required: false },
      { key: 'awsSecretAccessKey', label: 'AWS Secret Access Key', type: 'password', required: false },
      {
        key: 'apiKey',
        label: 'Bedrock API Key',
        type: 'password',
        required: false,
        helpText: 'Instead of an access key pair.',
      },
    ],
    requiresOneOf: [['awsAccessKeyId', 'awsSecretAccessKey'], ['apiKey']],
    usageHint: 'Name a model as bedrock/<model id>, e.g. bedrock/anthropic.claude-opus-4-7.',
    routingLive: true,
  },
  {
    id: 'vertex_ai',
    displayName: 'Google Vertex AI',
    docsUrl: 'https://cloud.google.com/vertex-ai/docs/authentication',
    fields: [
      { key: 'projectId', label: 'GCP Project ID', type: 'text', required: true },
      { key: 'location', label: 'Location', type: 'text', required: false, placeholder: 'global' },
      { key: 'serviceAccountJson', label: 'Service Account JSON', type: 'textarea', required: true, helpText: 'The full JSON key file contents for a service account with Vertex AI access.' },
    ],
    usageHint: 'Name a model as vertex/<model>, e.g. vertex/claude-sonnet-4-5@20250929 or vertex/gemini-2.5-pro.',
    routingLive: true,
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
    // TD-370: the proxy routes DEEPSEEK_API_MODEL_IDS here, reading this blob
    // (`deepseek_config`) the same way it reads Mistral's and OpenRouter's.
    id: 'deepseek',
    displayName: 'DeepSeek',
    docsUrl: 'https://platform.deepseek.com/api_keys',
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
 * DeepSeek's own API model ids — the only names the proxy routes to DeepSeek
 * (TD-370), matched exactly and case-insensitively. Mirrors
 * `DEEPSEEK_API_MODELS` in `packages/proxy/src/proxy.rs`; the parity test
 * compares the two lists. Not a prefix: `deepseek-r1`,
 * `deepseek-coder-v2-instruct` and other open-weight names are served by
 * Ollama, Groq, Together, ... behind the OpenAI-compatible upstream.
 */
export const DEEPSEEK_API_MODEL_IDS = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash'] as const

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
 * Order matters and matches the Rust exactly: a cloud prefix
 * ({@link cloudProviderForModel}) → claude → gemini → '/' (OpenRouter's
 * vendor/model namespacing — checked before the mistral prefixes so
 * "mistralai/..." routes to OpenRouter) → an exact DeepSeek API id
 * ({@link DEEPSEEK_API_MODEL_IDS}) → mistral prefixes → OpenAI as the
 * default arm. A `config.yaml` model alias is not visible here: it lives in
 * the proxy's own configuration.
 */
export function inferProviderForModel(
  model: string,
):
  | CloudProviderId
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'deepseek'
  | 'mistral'
  | 'openai' {
  const cloud = cloudProviderForModel(model)
  if (cloud) return cloud
  const m = model.toLowerCase()
  if (m.includes('claude')) return 'anthropic'
  if (m.includes('gemini')) return 'gemini'
  if (m.includes('/')) return 'openrouter'
  if ((DEEPSEEK_API_MODEL_IDS as readonly string[]).includes(m)) return 'deepseek'
  if (m.startsWith('mistral') || m.startsWith('open-mixtral') || m.startsWith('codestral')) {
    return 'mistral'
  }
  return 'openai'
}

/** Registry ids of the providers the proxy reaches through its cloud adapters. */
export type CloudProviderId = 'bedrock' | 'vertex_ai' | 'azure_openai'

/**
 * The cloud provider a `bedrock/`, `vertex/` (or `vertex_ai/`) or `azure/`
 * model name routes to — `crate::cloud::parse_prefixed` in the proxy.
 */
export function cloudProviderForModel(model: string): CloudProviderId | undefined {
  const slash = model.indexOf('/')
  if (slash <= 0 || model.slice(slash + 1).trim() === '') return undefined
  switch (model.slice(0, slash).toLowerCase()) {
    case 'bedrock':
      return 'bedrock'
    case 'vertex':
    case 'vertex_ai':
      return 'vertex_ai'
    case 'azure':
      return 'azure_openai'
    default:
      return undefined
  }
}

/** Host suffixes a workspace's Azure endpoint may use — `AZURE_HOST_SUFFIXES` in the proxy. */
export const AZURE_ENDPOINT_HOST_SUFFIXES = [
  '.openai.azure.com',
  '.services.ai.azure.com',
  '.cognitiveservices.azure.com',
] as const

const CLOUD_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * The same checks the proxy applies when it reads a stored cloud credential
 * (`cloud::config::from_workspace`), so a credential the proxy would refuse
 * is refused when it is saved instead. Returns the reason, or `null`.
 * Regions, locations and project ids become part of a hostname or URL path;
 * the Azure endpoint is a host the gateway sends the key to, so it must be
 * an Azure resource over TLS.
 */
export function checkCloudCredentialFields(providerId: string, values: Record<string, string>): string | null {
  switch (providerId) {
    case 'bedrock':
      return CLOUD_NAME.test(values.awsRegion ?? '') ? null : 'AWS Region must be a region name such as us-east-1'
    case 'vertex_ai': {
      if (!/^[a-z0-9-]{1,64}$/.test(values.projectId ?? '')) return 'GCP Project ID must be a project id or number'
      if (values.location !== undefined && !CLOUD_NAME.test(values.location)) {
        return 'Location must be a location name such as us-east5 or global'
      }
      let doc: unknown
      try {
        doc = JSON.parse(values.serviceAccountJson ?? '')
      } catch {
        return 'Service Account JSON is not valid JSON'
      }
      const type = (doc as { type?: unknown } | null)?.type
      return type === 'service_account' || type === 'authorized_user'
        ? null
        : 'Service Account JSON must be a service_account (or authorized_user) credential file'
    }
    case 'azure_openai': {
      let url: URL
      try {
        url = new URL(values.endpoint ?? '')
      } catch {
        return 'Resource Endpoint must be a URL'
      }
      const host = url.hostname.toLowerCase()
      const label = AZURE_ENDPOINT_HOST_SUFFIXES.map((sfx) => (host.endsWith(sfx) ? host.slice(0, -sfx.length) : null)).find(
        (l) => l !== null,
      )
      const ok = url.protocol === 'https:' && url.port === '' && url.username === '' && !!label && /^[a-z0-9-]+$/.test(label)
      return ok
        ? null
        : 'Resource Endpoint must be https://<resource>.openai.azure.com, .services.ai.azure.com or .cognitiveservices.azure.com'
    }
    default:
      return null
  }
}
