/**
 * The workspace setting `upstreamRetry`: how the LLM proxy retries a provider
 * call that failed before any response reached the client, and where it falls
 * back when those retries run out.
 *
 * Every field is optional and overrides the proxy's own `config.yaml` value
 * (`intutic_settings.routing.retry` / `.fallbacks`) field by field, so a
 * workspace can change one knob without restating the rest. The proxy reads
 * it from `/api/v1/auth/key-context` (`packages/proxy/src/routing/retry.rs`,
 * `WorkspaceRetry`); `fixtures/upstream-retry-vectors.json` holds the two
 * readings together.
 */
import { z } from 'zod'

/**
 * The ceilings both the schema and the proxy enforce, so no setting can
 * configure a retry storm. The proxy clamps `config.yaml` to the same values
 * (`RetryConfig::bounded`); a test holds the two equal.
 */
export const UPSTREAM_RETRY_LIMITS = {
  maxAttempts: 5,
  maxBackoffMs: 60_000,
  budgetMs: 120_000,
  fallbackTargets: 5,
  fallbackModels: 50,
} as const

/** Retried by default: 429, 500, 502, 503, 504 and Anthropic's 529 overloaded. */
export const DEFAULT_UPSTREAM_RETRY_STATUSES = [429, 500, 502, 503, 504, 529] as const

/** The defaults the proxy applies when neither config.yaml nor the workspace sets a field. */
export const DEFAULT_UPSTREAM_RETRY = {
  enabled: true,
  maxAttempts: 3,
  initialBackoffMs: 500,
  maxBackoffMs: 8_000,
  budgetMs: 30_000,
  onStatus: [...DEFAULT_UPSTREAM_RETRY_STATUSES],
} as const

/**
 * Providers a fallback target may name: every id the proxy resolves
 * (`provider_from_wire_id` in packages/proxy/src/proxy.rs), the cloud
 * providers' aliases included, so a target copied from config.yaml is valid
 * here too. A test holds the two lists equal.
 */
export const UPSTREAM_PROVIDERS = [
  'anthropic',
  'openai',
  'gemini',
  'mistral',
  'openrouter',
  'deepseek',
  'bedrock',
  'vertex_ai',
  'vertex',
  'azure_openai',
  'azure',
] as const
export type UpstreamProvider = (typeof UPSTREAM_PROVIDERS)[number]

/**
 * One fallback target. `model` alone switches model on the provider that
 * model resolves to; `provider` alone sends the same model to another
 * provider; both pin the pair.
 */
export const UpstreamFallbackTargetSchema = z
  .object({
    model: z.string().trim().min(1).max(200).optional(),
    provider: z.enum(UPSTREAM_PROVIDERS).optional(),
  })
  .strict()
  .refine((t) => t.model !== undefined || t.provider !== undefined, {
    message: 'A fallback target names a model, a provider, or both',
  })
export type UpstreamFallbackTarget = z.infer<typeof UpstreamFallbackTargetSchema>

export const UpstreamRetrySettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxAttempts: z.number().int().min(1).max(UPSTREAM_RETRY_LIMITS.maxAttempts).optional(),
    initialBackoffMs: z.number().int().min(0).max(UPSTREAM_RETRY_LIMITS.maxBackoffMs).optional(),
    maxBackoffMs: z.number().int().min(0).max(UPSTREAM_RETRY_LIMITS.maxBackoffMs).optional(),
    budgetMs: z.number().int().min(0).max(UPSTREAM_RETRY_LIMITS.budgetMs).optional(),
    onStatus: z.array(z.number().int().min(400).max(599)).max(20).optional(),
    /** Ordered targets, keyed by the model whose retries ran out. */
    fallbacks: z
      .record(
        z.string().trim().min(1).max(200),
        z.array(UpstreamFallbackTargetSchema).min(1).max(UPSTREAM_RETRY_LIMITS.fallbackTargets),
      )
      .refine((f) => Object.keys(f).length <= UPSTREAM_RETRY_LIMITS.fallbackModels, {
        message: `At most ${UPSTREAM_RETRY_LIMITS.fallbackModels} models may have fallbacks`,
      })
      .optional(),
  })
  .strict()
export type UpstreamRetrySettings = z.infer<typeof UpstreamRetrySettingsSchema>
