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
