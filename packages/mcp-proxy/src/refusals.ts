/**
 * refusals.ts — the stable code every refusal this proxy gives carries.
 *
 * A JSON-RPC refusal is `-32603` with a message, and a message is for a
 * person: an agent or client that wants to tell a held call from a blocked
 * one, or a used-up budget from a disabled tool, should not have to parse it.
 * So every refusal frame also carries `error.data`: `code` (one of
 * {@link MCP_REFUSAL_CODES}), `ruleId` (the rule, setting or detector that
 * decided) and, where there is more to say, more fields — the hold's
 * `holdId` and `status`, a budget's `budgetId`, `limit`, `used` and
 * `resetAt`.
 *
 * In an OPAQUE workspace a refusal on workspace policy
 * ({@link OPAQUE_REFUSAL_CODES}) is sent with `OPAQUE_REFUSAL_MESSAGE`
 * (`@intutic/shared-types`) in place of its reason, and `error.data` keeps
 * its `code` but names no rule: `ruleId` is `''` (the field stays, as a
 * string, so a client that reads it still parses), and the detail is dropped
 * except a hold's `holdId` and `status`, which name the hold, not the policy.
 *
 * Held to `packages/shared-types/fixtures/refusal-codes.json` (`mcp`) by a
 * test, as the MCP proxy reference's table is.
 *
 * @module
 */

export const MCP_REFUSAL_CODES = [
  'REGISTRY_UNAVAILABLE',
  'SERVER_BLOCKED',
  'SERVER_HELD',
  'SERVER_NOT_APPROVED',
  'TOOL_DISABLED',
  'SERVER_NOT_ALLOWED',
  'TOOL_NOT_ALLOWED',
  'SSO_GROUP',
  'DLP',
  'SOP_RULE',
  'HELD',
  'INJECTION',
  'ANOMALY',
  'WASM_RULE',
  'REASK',
  'REASK_EXHAUSTED',
  'BUDGET_EXCEEDED',
  'BUDGET_UNAVAILABLE',
  'GOVERNANCE_UNAVAILABLE',
  'TOFU_UNAVAILABLE',
  'TOOL_DEFINITIONS_CHANGED',
  'RESULT_WITHHELD_DLP',
  'RESULT_WITHHELD_INJECTION',
] as const

export type McpRefusalCode = (typeof MCP_REFUSAL_CODES)[number]

/** `error.data` on a refusal frame. */
export interface RefusalData {
  code: McpRefusalCode
  ruleId: string
  [detail: string]: unknown
}

/**
 * The refusals on workspace policy: in an OPAQUE workspace the agent is not
 * told which rule, setting or detector refused it. The rest are operational —
 * the control plane or a store unreachable, a pin check that could not run,
 * a server whose tools changed, a budget used up (whose detail says when it
 * resets) — and name no rule an agent could route around, so they are sent
 * unchanged.
 */
export const OPAQUE_REFUSAL_CODES: ReadonlySet<McpRefusalCode> = new Set<McpRefusalCode>([
  'SERVER_BLOCKED',
  'SERVER_HELD',
  'SERVER_NOT_APPROVED',
  'TOOL_DISABLED',
  'SERVER_NOT_ALLOWED',
  'TOOL_NOT_ALLOWED',
  'SSO_GROUP',
  'DLP',
  'SOP_RULE',
  'HELD',
  'INJECTION',
  'ANOMALY',
  'WASM_RULE',
  'REASK',
  'REASK_EXHAUSTED',
  'RESULT_WITHHELD_DLP',
  'RESULT_WITHHELD_INJECTION',
])

/**
 * Whether an OPAQUE workspace's agent is told the generic sentence for this
 * refusal: a code in {@link OPAQUE_REFUSAL_CODES}, or a custom rule that
 * reached no verdict (`GOVERNANCE_UNAVAILABLE` with a `wasm:` rule id), whose
 * message names the rule. The LLM proxy hides the same one.
 */
export function isOpaqueRefusal(data: RefusalData): boolean {
  return OPAQUE_REFUSAL_CODES.has(data.code) ||
    (data.code === 'GOVERNANCE_UNAVAILABLE' && data.ruleId.startsWith('wasm:'))
}

/** `error.data` as an OPAQUE workspace's agent receives it: the code, no rule. */
export function opaqueRefusalData(data: RefusalData): RefusalData {
  return data.code === 'HELD'
    ? { code: 'HELD', ruleId: '', status: data['status'], holdId: data['holdId'] }
    : { code: data.code, ruleId: '' }
}
