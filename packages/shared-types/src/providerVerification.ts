/**
 * Provider credential verification (LLD #70, model catalog & cohort wizard).
 *
 * Pure, network-free description of how to check whether a credential works —
 * the cheapest authenticated call each provider's own API exposes. Two
 * different executors run the same probe spec because a credential crosses a
 * trust boundary differently depending on who holds it at verification time:
 *
 * - `tools/cli/src/lib/providerProbe.ts` — the CLI legitimately holds a raw
 *   key locally before it is ever sent anywhere, and probes with it directly.
 * - `services/control-plane/src/lib/providerVerify.ts` — probes a credential
 *   already stored in Valkey, server-side, so the raw value never has to
 *   leave the control plane a second time.
 *
 * Neither executor lives in this package (no network calls here — shared-types
 * is pure data and types, consumed by both the CLI and the control plane).
 * This module only describes WHAT to request; each executor decides HOW to
 * make that request in its own runtime.
 *
 * Deliberately, no probe here targets `/v1/chat/completions` —
 * `services/control-plane/__tests__/unit/monitorSeparation.test.ts` treats
 * every fetch call to that literal URL shape as a judge/generation call
 * requiring classification. A verification probe is neither; it must not add
 * a site to that census.
 *
 * @module
 */

export interface ProviderProbeRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  /** Present only for POST probes (currently: Anthropic's 1-token message). */
  body?: string
}

/**
 * Build the cheapest authenticated request that proves a credential works,
 * or `null` if this provider has no such probe defined yet.
 *
 * `fields` is the provider's credential field map exactly as stored — the
 * same shape `PROVIDER_REGISTRY`'s `ProviderCredentialField.key`s describe
 * (`providers.ts`), e.g. `{ apiKey: '...' }` for Anthropic, `{ apiKey, endpoint,
 * deploymentName }` for Azure OpenAI.
 *
 * Bedrock and Vertex AI return `null`: verifying them means SigV4 request
 * signing or a GCP OAuth2/JWT exchange, neither of which exists anywhere in
 * this codebase yet (the same "real per-provider engineering, not a config
 * change" boundary LLD #67 §3 draws around routing those two providers). A
 * caller seeing `null` should say "cannot verify automatically," not fail
 * the credential.
 */
export function buildVerificationProbe(
  provider: string,
  fields: Record<string, string>,
): ProviderProbeRequest | null {
  switch (provider) {
    case 'anthropic': {
      const apiKey = fields.apiKey
      if (!apiKey) return null
      // Anthropic's API has no /v1/models endpoint to probe cheaply, so the
      // cheapest real call is a 1-max-token message — costs about one token.
      return {
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }
    }

    case 'openai': {
      const apiKey = fields.apiKey
      if (!apiKey) return null
      return {
        url: 'https://api.openai.com/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    }

    case 'mistral': {
      const apiKey = fields.apiKey
      if (!apiKey) return null
      return {
        url: 'https://api.mistral.ai/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    }

    case 'openrouter': {
      const apiKey = fields.apiKey
      if (!apiKey) return null
      return {
        url: 'https://openrouter.ai/api/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    }

    case 'cohere': {
      const apiKey = fields.apiKey
      if (!apiKey) return null
      return {
        url: 'https://api.cohere.com/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    }

    case 'gemini': {
      const apiKey = fields.apiKey
      if (!apiKey) return null
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        method: 'GET',
        headers: {},
      }
    }

    case 'azure_openai': {
      const apiKey = fields.apiKey
      const endpoint = fields.endpoint?.replace(/\/+$/, '')
      if (!apiKey || !endpoint) return null
      return {
        url: `${endpoint}/openai/models?api-version=2024-02-01`,
        method: 'GET',
        headers: { 'api-key': apiKey },
      }
    }

    case 'ollama': {
      const apiBase = fields.apiBase?.replace(/\/+$/, '')
      if (!apiBase) return null
      // Ollama has no API key by default — this checks reachability, not
      // authentication. A 200 here means "something is listening," which is
      // the most this provider's shape lets a probe promise.
      return {
        url: `${apiBase}/api/tags`,
        method: 'GET',
        headers: {},
      }
    }

    case 'bedrock':
    case 'vertex_ai':
      return null

    default:
      return null
  }
}

export type ProbeVerdict = 'valid' | 'invalid' | 'unknown'

/**
 * Classify a probe's HTTP response. Deliberately narrow about what counts as
 * "invalid": only 401/403 mean the credential itself is wrong. A 429
 * (rate-limited) or 5xx (upstream trouble) still proves the key is
 * authenticated — reporting either as invalid would tell an operator to
 * re-enter a working key. `unknown` covers both cases plus a request that
 * never got a response at all (network error, timeout) — callers should
 * treat `unknown` as "could not verify," not as a failure, and let the
 * operator proceed.
 */
export function classifyProbeResponse(httpStatus: number): ProbeVerdict {
  if (httpStatus >= 200 && httpStatus < 300) return 'valid'
  if (httpStatus === 401 || httpStatus === 403) return 'invalid'
  return 'unknown'
}
