/**
 * Shared error codes and error class for the Intutic platform.
 *
 * All services throw `IntuticError` instances so that HTTP handlers can
 * reliably extract `code`, `statusCode`, and `details` for structured
 * error responses.
 *
 * @module
 */

// ─── Error Code Constants ────────────────────────────────────────────

/** Resource not found. */
export const E_NOT_FOUND = 'E_NOT_FOUND' as const

/** Cache service is down or temporarily unreachable. */
export const E_CACHE_UNAVAILABLE = 'E_CACHE_UNAVAILABLE' as const


/** Missing or invalid authentication credentials. */
export const E_UNAUTHORIZED = 'E_UNAUTHORIZED' as const

/** Authenticated but insufficient permissions. */
export const E_FORBIDDEN = 'E_FORBIDDEN' as const

/** Budget limit exceeded — HLD §3.6 FinOps guardrail. */
export const E_BUDGET_EXCEEDED = 'E_BUDGET_EXCEEDED' as const

/** Request rate limit exceeded. */
export const E_RATE_LIMITED = 'E_RATE_LIMITED' as const

/** Attempted UPDATE/DELETE on an append-only table (e.g., execution_traces). */
export const E_APPEND_ONLY_VIOLATION = 'E_APPEND_ONLY_VIOLATION' as const

/** High-risk plan approval requires a human-written rationale (EU AI Act Art. 14). */
export const E_APPROVAL_RATIONALE_REQUIRED = 'E_APPROVAL_RATIONALE_REQUIRED' as const

/** Request payload failed Zod schema validation. */
export const E_VALIDATION_FAILED = 'E_VALIDATION_FAILED' as const

/** Stripe/billing checkout disabled or unavailable. */
export const E_CHECKOUT_DISABLED = 'CHECKOUT_DISABLED' as const

/** Workspace already on the requested tier. */
export const E_ALREADY_ON_TIER = 'ALREADY_ON_TIER' as const

/** Stripe API error. */
export const E_STRIPE_ERROR = 'STRIPE_ERROR' as const

/** Webhook signature validation failed. */
export const E_SIGNATURE_INVALID = 'SIGNATURE_INVALID' as const

/** Workspace free trial has expired. */
export const E_TRIAL_EXPIRED = 'TRIAL_EXPIRED' as const

/** Email already registered. */
export const E_EMAIL_ALREADY_EXISTS = 'EMAIL_ALREADY_EXISTS' as const

/** OAuth flow failure. */
export const E_OAUTH_FAILED = 'OAUTH_FAILED' as const

/** Token is invalid or malformed. */
export const E_TOKEN_INVALID = 'TOKEN_INVALID' as const

/** Token has expired. */
export const E_TOKEN_EXPIRED = 'TOKEN_EXPIRED' as const

/** Resource is already in the target state. */
export const E_ALREADY_VERIFIED = 'ALREADY_VERIFIED' as const

/** Generic validation failure (legacy alias). */
export const E_VALIDATION = 'E_VALIDATION' as const

// ─── Identity Federation Error Codes (LLD #11) ─────────────────────

/** SSO is not configured or disabled for this workspace. */
export const E_SSO_DISABLED = 'SSO_DISABLED' as const

/** SSO user has no workspace membership. */
export const E_SSO_NO_MEMBERSHIP = 'SSO_NO_MEMBERSHIP' as const

/** OIDC state parameter is invalid or expired. */
export const E_OIDC_INVALID_STATE = 'OIDC_INVALID_STATE' as const

/** OIDC token exchange with the IdP failed. */
export const E_OIDC_TOKEN_EXCHANGE_FAILED = 'OIDC_TOKEN_EXCHANGE_FAILED' as const

/** Required claims missing from OIDC id_token. */
export const E_OIDC_CLAIMS_MISSING = 'OIDC_CLAIMS_MISSING' as const

/** SSO provider exists but is disabled. */
export const E_PROVIDER_DISABLED = 'PROVIDER_DISABLED' as const

/** Cannot delete provider — active members are using it. */
export const E_PROVIDER_IN_USE = 'PROVIDER_IN_USE' as const

/** SCIM bearer token authentication failed. */
export const E_SCIM_AUTH_FAILED = 'SCIM_AUTH_FAILED' as const

/** SCIM resource already exists (duplicate externalId). */
export const E_SCIM_DUPLICATE = 'SCIM_DUPLICATE' as const

/** Offboarding cascade is already running for this user. */
export const E_OFFBOARDING_IN_PROGRESS = 'OFFBOARDING_IN_PROGRESS' as const

/** Feature is not available on the current plan tier. */
export const E_FEATURE_NOT_AVAILABLE = 'FEATURE_NOT_AVAILABLE' as const

// ─── WS4 — Enterprise Identity & Compliance (LLD #19) ───────────────

/**
 * Requested child capabilities are not a subset of the parent key's capabilities.
 * HLD §5.6 — DCT Token Attenuation (Patent Family A).
 */
export const E_ATTENUATION_CAP_VIOLATION = 'ATTENUATION_CAP_VIOLATION' as const

// ─── WS5 — Monetization & Financial Ledger (LLD #20) ────────────────

/**
 * Daily spend cap exceeded with hard enforcement mode active.
 * Proxy returns this when budget:hard_block:{wid} Valkey key is set.
 */
export const E_OVERAGE_HARD_CAP_EXCEEDED = 'OVERAGE_HARD_CAP_EXCEEDED' as const

/**
 * Union of all Intutic error code constants.
 *
 * Use this type to constrain error handling branches:
 * ```ts
 * function handle(code: IntuticErrorCode) { ... }
 * ```
 */
export type IntuticErrorCode =
  | typeof E_NOT_FOUND
  | typeof E_CACHE_UNAVAILABLE

  | typeof E_UNAUTHORIZED
  | typeof E_FORBIDDEN
  | typeof E_BUDGET_EXCEEDED
  | typeof E_RATE_LIMITED
  | typeof E_APPEND_ONLY_VIOLATION
  | typeof E_APPROVAL_RATIONALE_REQUIRED
  | typeof E_VALIDATION_FAILED
  | typeof E_CHECKOUT_DISABLED
  | typeof E_ALREADY_ON_TIER
  | typeof E_STRIPE_ERROR
  | typeof E_SIGNATURE_INVALID
  | typeof E_TRIAL_EXPIRED
  | typeof E_EMAIL_ALREADY_EXISTS
  | typeof E_OAUTH_FAILED
  | typeof E_TOKEN_INVALID
  | typeof E_TOKEN_EXPIRED
  | typeof E_ALREADY_VERIFIED
  | typeof E_VALIDATION
  // Identity Federation (LLD #11)
  | typeof E_SSO_DISABLED
  | typeof E_SSO_NO_MEMBERSHIP
  | typeof E_OIDC_INVALID_STATE
  | typeof E_OIDC_TOKEN_EXCHANGE_FAILED
  | typeof E_OIDC_CLAIMS_MISSING
  | typeof E_PROVIDER_DISABLED
  | typeof E_PROVIDER_IN_USE
  | typeof E_SCIM_AUTH_FAILED
  | typeof E_SCIM_DUPLICATE
  | typeof E_OFFBOARDING_IN_PROGRESS
  | typeof E_FEATURE_NOT_AVAILABLE
  // WS4 — Enterprise Identity & Compliance (LLD #19)
  | typeof E_ATTENUATION_CAP_VIOLATION
  // WS5 — Monetization & Financial Ledger (LLD #20)
  | typeof E_OVERAGE_HARD_CAP_EXCEEDED

// ─── Error Class ─────────────────────────────────────────────────────

/**
 * Structured error class used across all Intutic services.
 *
 * Every error carries a machine-readable `code`, an HTTP `statusCode`,
 * and optional `details` for diagnostics.
 *
 * @example
 * ```typescript
 * import { IntuticError, E_BUDGET_EXCEEDED } from '@intutic/shared-types'
 *
 * throw new IntuticError(
 *   E_BUDGET_EXCEEDED,
 *   402,
 *   'Monthly budget of $500.00 exceeded',
 *   { currentSpend: 512.34, limit: 500.00 }
 * )
 * ```
 */
export class IntuticError extends Error {
  /** Machine-readable error code (e.g., `E_BUDGET_EXCEEDED`). */
  readonly code: IntuticErrorCode

  /** HTTP status code to return (e.g., 402, 403, 404). */
  readonly statusCode: number

  /** Optional structured details for diagnostics. */
  readonly details?: Record<string, unknown>

  constructor(
    code: IntuticErrorCode,
    statusCode: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'IntuticError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

/**
 * Type guard for IntuticError. Highly robust against duplicate prototype imports.
 */
export function isIntuticError(err: unknown): err is IntuticError {
  return (
    err instanceof Error &&
    (err.name === 'IntuticError' ||
      err.constructor.name === 'IntuticError' ||
      ('_isIntuticError' in err && (err as any)._isIntuticError === true) ||
      ('code' in err && 'statusCode' in err))
  );
}

