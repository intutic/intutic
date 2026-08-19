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
 * registry's own NO_GATE rows: `file: null` harnesses split between 'sdk'
 * (LangGraph + the Python frameworks — the gate ships in intutic-clawde) and
 * 'delegated' (xirp — the gate is whichever wrapped harness's own gate is
 * running); the one non-null row (aiderConfigMerger.ts, "no ... exists") is
 * 'none'.
 *
 * @module
 */

import { HarnessType, type HarnessType as HarnessTypeT } from '@intutic/shared-types'

/**
 * `'hook'`      — the daemon writes an on-disk hook/config file this harness
 *                 reads before running a tool call (the 19-harness majority).
 * `'sdk'`       — the blocking gate ships in `intutic-clawde`, imported into
 *                 the harness's own Python process; no file for the daemon
 *                 to write or verify (LangGraph + the eight Wave/Wave-2
 *                 frameworks).
 * `'none'`      — no enforcement point exists today at all (aider: its only
 *                 native hook is post-edit and /run-blind).
 * `'delegated'` — this harness has no gate mechanism of its own because it
 *                 does not run tools itself: it wraps OTHER harnesses that
 *                 are already `'hook'`- or `'sdk'`-gated, and a tool call
 *                 made inside it is governed by whichever wrapped harness's
 *                 own gate is running (Xirp today; see gateRegistry.ts's
 *                 NO_GATE row for the reasoning this precedent sets for
 *                 future orchestrator-shaped harnesses). Distinct from
 *                 `'none'`: `'none'` means no enforcement point exists
 *                 ANYWHERE for this harness's tool calls; `'delegated'`
 *                 means one exists, just not one this harness's own row
 *                 owns or can be credited for independently — reporting it
 *                 as `'none'` would undercount real coverage, and reporting
 *                 it as `'hook'` would overclaim a file this daemon never
 *                 writes for the wrapping harness itself.
 */
export type GateKind = 'hook' | 'sdk' | 'none' | 'delegated'

/**
 * Harnesses whose blocking gate ships SDK-side, in the harness's own
 * process — no on-disk hook/config file exists to point a gate at. Mirrors
 * the `file: null` NO_GATE rows in `gateRegistry.ts`.
 *
 * MASTRA and VERCEL_AI_SDK (T2) are the JS/TS-native members of this family:
 * their blocking gate ships in `@intutic/gate/mastra`/`@intutic/gate/vercel`
 * (packages/gate-js) rather than `intutic-clawde`, but the shape is
 * identical — no on-disk hook/config file, tools run as plain callables in
 * the harness's own process.
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
  HarnessType.MASTRA,
  HarnessType.VERCEL_AI_SDK,
])

/**
 * Harnesses with no enforcement point at all today. Mirrors the
 * `aiderConfigMerger.ts` NO_GATE row: aider's only native hook
 * (`--git-commit-verify`) is opt-in, post-edit, and blind to `/run`.
 */
export const NO_GATE_HARNESSES: ReadonlySet<HarnessTypeT> = new Set([HarnessType.AIDER])

/**
 * Harnesses that wrap OTHER already-gated harnesses instead of running tools
 * themselves — no gate of their own, but not ungoverned either. Mirrors the
 * `file: null` NO_GATE row for `xirp` in `gateRegistry.ts`. The first entry
 * here; O2 (QM) and O3 (agentic-orchestrator) are expected to add the next
 * two, same "wraps other harnesses" shape.
 */
export const DELEGATED_GATE_HARNESSES: ReadonlySet<HarnessTypeT> = new Set([HarnessType.XIRP])

/** How this harness's tool calls get gated. Defaults to `'hook'`. */
export function gateKindForHarness(type: HarnessTypeT): GateKind {
  if (SDK_GATED_HARNESSES.has(type)) return 'sdk'
  if (NO_GATE_HARNESSES.has(type)) return 'none'
  if (DELEGATED_GATE_HARNESSES.has(type)) return 'delegated'
  return 'hook'
}
