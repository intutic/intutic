/**
 * gateKind.ts — classifies each harness by HOW its tool calls get governed,
 * for `agentReporter.ts`'s `guardrails` facet.
 *
 * # Why this exists
 *
 * `collectAgentReport` used to report `hook_gate: true` unconditionally for
 * every harness, with the comment "the daemon writes the hook gate for every
 * harness it supports." That was already false for `langgraph` — which has
 * no on-disk hook, only the SDK-side `intutic_clawde.gate` — and for `aider`,
 * whose only NO_GATE-registered mechanism is a post-edit, /run-blind
 * pre-commit hook (see `aiderConfigMerger.ts`'s NO_GATE row in
 * `__tests__/harness/gateRegistry.ts`). Wave 1 adds eight more SDK-gated
 * harnesses, which would have made the lie eight times larger without this
 * fix.
 *
 * # What this does NOT do
 *
 * This does not verify that a user actually pip-installed `intutic-clawde`
 * and wired `guard_tools`/`IntuticMiddleware`/etc. into their process — the
 * daemon cannot observe another process's imports, the same way it cannot
 * observe whether a written hook file was left executable. It only reports
 * which MECHANISM this harness's governance model uses (a file the daemon
 * itself writes and can verify existence of, vs. an SDK the harness's own
 * process must import), matching the trust level `hook_gate: true` already
 * carried for file-based harnesses before this fix.
 *
 * # Keeping this in sync with the gate registry
 *
 * `services/sync-daemon/__tests__/harness/gateRegistry.ts` (the GATES/NO_GATE
 * completeness registry exercised by `generatedGateBehaviour.test.ts`) is the
 * authoritative decision per harness, but it is a test-only module (it
 * dynamically imports every writer's compiled `.js` from a temp build dir)
 * and must not be imported from daemon runtime code. `gateKind.test.ts`
 * cross-checks the two lists so this file cannot silently drift from that
 * registry's own NO_GATE `file: null` (→ 'sdk') / non-null-with-"no ...
 * exists" (→ 'none') rows.
 *
 * @module
 */

import { HarnessType, type HarnessType as HarnessTypeT } from '@intutic/shared-types'

/**
 * `'hook'`   — the daemon writes an on-disk hook/config file this harness
 *              reads before running a tool call (the 19-harness majority).
 * `'sdk'`    — the blocking gate ships in `intutic-clawde`, imported into the
 *              harness's own Python process; no file for the daemon to write
 *              or verify (LangGraph + the eight Wave/Wave-2 frameworks).
 * `'none'`   — no enforcement point exists today at all (aider: its only
 *              native hook is post-edit and /run-blind).
 */
export type GateKind = 'hook' | 'sdk' | 'none'

/**
 * Harnesses whose blocking gate ships SDK-side, in the harness's own
 * process — no on-disk hook/config file exists to point a gate at. Mirrors
 * the `file: null` NO_GATE rows in `gateRegistry.ts`.
 */
export const SDK_GATED_HARNESSES: ReadonlySet<HarnessTypeT> = new Set([
  HarnessType.LANGGRAPH,
  HarnessType.LANGCHAIN,
  HarnessType.CREWAI,
  HarnessType.AUTOGEN,
  HarnessType.AG2,
  HarnessType.GOOGLE_ADK,
  HarnessType.OPENAI_AGENTS,
  HarnessType.PYDANTIC_AI,
  HarnessType.SMOLAGENTS,
])

/**
 * Harnesses with no enforcement point at all today. Mirrors the
 * `aiderConfigMerger.ts` NO_GATE row: aider's only native hook
 * (`--git-commit-verify`) is opt-in, post-edit, and blind to `/run`.
 */
export const NO_GATE_HARNESSES: ReadonlySet<HarnessTypeT> = new Set([HarnessType.AIDER])

/** How this harness's tool calls get gated. Defaults to `'hook'`. */
export function gateKindForHarness(type: HarnessTypeT): GateKind {
  if (SDK_GATED_HARNESSES.has(type)) return 'sdk'
  if (NO_GATE_HARNESSES.has(type)) return 'none'
  return 'hook'
}
