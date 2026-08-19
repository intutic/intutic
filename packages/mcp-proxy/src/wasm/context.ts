/**
 * wasm/context.ts — Builds the `RequestContext` JSON this proxy honestly has
 * data for, matching the field NAMES `packages/proxy/src/wasm/context.rs`
 * (and its AssemblyScript mirror, `packages/wasm-sdk/assembly/index.ts`)
 * already define, so an existing WASM rule reads this exactly the way it
 * reads the Rust LLM-traffic proxy's context.
 *
 * Deliberately incomplete: `harness`, `model`, every budget/cost field, every
 * graph/node-identity field, and every SOP-declaration field
 * (`denied_tools`/`plan_steps`/`scope_paths`/...) are OMITTED — not sent as
 * `null`, simply absent — because this proxy has no honest value for them.
 * AssemblyScript's `JSON.parse`-based `readContext` (assembly/index.ts)
 * leaves a missing field at its class default (empty string / 0 / empty
 * array), which is the "unknown" reading a well-written rule already has to
 * handle for the Rust proxy's own `-1`-sentinelled fields — never a
 * fabricated value.
 *
 * @module
 */

import type { ToolsListEntry } from '../session.js'

export interface WasmContextInput {
  sessionId: string
  workspaceId: string
  /** The post-curation `tools/list` this session last saw (SessionState). */
  tools: readonly ToolsListEntry[]
  /**
   * A synthesized identifier for the CURRENT tool call — MCP has no
   * server-assigned call id the way Anthropic's `tool_use_id` is; this
   * proxy mints one for context-building purposes only, honestly labeled
   * as this proxy's own synthesized value, not claimed to be anything the
   * harness itself asserted.
   */
  toolCallId: string
  toolName: string
  toolArguments: unknown
  /** The prospective sequence (current call included) — same array Phase 2's detectors evaluate against. */
  toolSequence: readonly string[]
  callsLast60s: number
  /** This call's OWN DLP scan findings — see dlpEscalation's callers: by
   *  pipeline position, a non-empty result here would already have blocked
   *  the request at interceptor.ts's DLP step, so this is honestly almost
   *  always empty by construction, not a bug in this builder. */
  dlpFindingDescriptions: readonly string[]
  injectionFindings: readonly string[]
  injectionSources: readonly string[]
  corroboratingDetectors: number
  /** `undefined` when no `tools/list` response has been TOFU-checked yet this session. */
  toolContractChanged: boolean | undefined
}

/** `(tool, count)` pairs, wire-shaped as 2-element arrays — see context.ts's module doc. */
function foldToolCallCounts(sequence: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const tool of sequence) counts.set(tool, (counts.get(tool) ?? 0) + 1)
  return Array.from(counts.entries())
}

/**
 * Builds the plain object to `JSON.stringify` and hand to a WASM rule's
 * `evaluate(offset, len)` export. Field names match `context.rs`/
 * `assembly/index.ts` exactly; fields this proxy has no honest data for are
 * not present as keys at all.
 */
export function buildWasmContext(input: WasmContextInput): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    session_id: input.sessionId,
    workspace_id: input.workspaceId,
    tools: input.tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
    tool_calls: [{ id: input.toolCallId, name: input.toolName, arguments: input.toolArguments ?? {} }],
    tool_sequence: [...input.toolSequence],
    tool_call_counts: foldToolCallCounts(input.toolSequence),
    calls_last_60s: input.callsLast60s,
    // Our own DLP scanner has no offset/length tracking (dlp.ts never
    // recorded match spans), so `pattern_name` is the only field populated
    // — mapped from the finding's human-readable description (the closest
    // honest analogue this scanner has to a pattern identity).
    // `category`/`action`/`offset`/`length` are left absent rather than
    // fabricated; the AssemblyScript `DlpFinding` class defaults them to
    // `""`/0, the same "unknown" reading every other absent field gets.
    dlp_findings: input.dlpFindingDescriptions.map((description) => ({ pattern_name: description })),
    injection_findings: [...input.injectionFindings],
    injection_sources: [...input.injectionSources],
    corroborating_detectors: input.corroboratingDetectors,
  }
  if (input.toolContractChanged !== undefined) {
    ctx['tool_contract_changed'] = input.toolContractChanged
  }
  return ctx
}
