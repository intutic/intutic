/**
 * Why a proxy refused to load a custom (WASM or Rego) rule version. The Rust
 * proxy files a control-plane rule it refuses under one of these, and the
 * control plane opens the incident with it; the MCP proxy, which loads only
 * local rule files, logs the same names. One list, so a reason means the same
 * thing wherever it is read.
 *
 * @module
 */

export const RULE_LOAD_FAILURE_REASONS = ['missing', 'hash_mismatch', 'compile_error', 'unsupported_import', 'load_error'] as const

export type RuleLoadFailureReason = (typeof RULE_LOAD_FAILURE_REASONS)[number]

/** What each reason means, as an incident or a log states it. */
export const RULE_LOAD_FAILURE_TEXT: Record<RuleLoadFailureReason, string> = {
  missing: 'its binary is missing',
  hash_mismatch: 'its binary does not hash to the SHA-256 its descriptor names',
  compile_error: 'its binary is not a WebAssembly module the proxy compiles',
  unsupported_import: 'it imports a host function the proxy does not provide',
  load_error: 'the proxy cannot run it, such as an OPA build using a builtin the host does not provide',
}

export function isRuleLoadFailureReason(value: unknown): value is RuleLoadFailureReason {
  return (RULE_LOAD_FAILURE_REASONS as readonly unknown[]).includes(value)
}
