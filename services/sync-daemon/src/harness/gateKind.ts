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
 * (LangGraph + the Python frameworks — the gate ships in intutic-clawde),
 * 'delegated' (xirp — the gate is whichever wrapped harness's own gate is
 * running), and 'bridge' (trueforge-server — the gate runs in a separate
 * Intutic-operated service, not in any process this repo's writers touch);
 * the one non-null row (aiderConfigMerger.ts, "no ... exists") is 'none'.
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
 *                 own gate is running (Xirp, Agentic Orchestrator, and — a
 *                 different shape of the same idea — AgentCore Runtime,
 *                 which HOSTS a customer's already-gated framework code
 *                 rather than spawning it as a subprocess; see
 *                 gateRegistry.ts's NO_GATE rows for the reasoning this
 *                 precedent sets for future orchestrator/host-shaped
 *                 harnesses).
 *                 NOTE: "governed by whichever wrapped harness's own gate is
 *                 running" assumes that wrapped harness HAS a gate — Agentic
 *                 Orchestrator's `opencode` backend does not (no OpenCode
 *                 adapter exists in this registry at all), so `'delegated'`
 *                 slightly overclaims for that one backend; see TD-397. It
 *                 remains the correct classification for the harness AS A
 *                 WHOLE because its other two backends (claude, codex) are
 *                 fully gated. Distinct from
 *                 `'none'`: `'none'` means no enforcement point exists
 *                 ANYWHERE for this harness's tool calls; `'delegated'`
 *                 means one exists, just not one this harness's own row
 *                 owns or can be credited for independently — reporting it
 *                 as `'none'` would undercount real coverage, and reporting
 *                 it as `'hook'` would overclaim a file this daemon never
 *                 writes for the wrapping harness itself.
 * `'bridge'`    — the gate runs OUT OF PROCESS, in an Intutic-operated
 *                 service reacting to the harness's own async
 *                 approval/event API, rather than a file this daemon writes
 *                 (`'hook'`), an SDK imported into the harness's own process
 *                 (`'sdk'`), no enforcement point at all (`'none'`), or
 *                 governance credited to a wrapped harness's own gate
 *                 (`'delegated'`) — a fifth, genuinely different shape.
 *                 TRUEFORGE_SERVER is the first and so far only member: a
 *                 TrueForge standalone/hosted server is a separate process
 *                 nobody embeds an Intutic gate into (unlike TRUEFORGE,
 *                 embedded mode, which IS `'sdk'`-gated — see that row's own
 *                 doc), so `services/trueforge-bridge` watches its turn/event
 *                 stream externally and answers pending approvals over HTTP.
 *                 Distinct from `'delegated'`: a delegated harness's tool
 *                 calls are governed by ANOTHER HARNESS's own gate running
 *                 in that other harness's process; a bridge-gated harness's
 *                 tool calls are governed by a service this repo ships and
 *                 operates, running in neither the harness's process nor any
 *                 other harness's. Distinct from `'sdk'`: no code from this
 *                 repo ever runs inside the governed harness's own process
 *                 at all — the harness's only obligation is to expose the
 *                 async approval API the bridge polls/subscribes to.
 */
export type GateKind = 'hook' | 'sdk' | 'none' | 'delegated' | 'bridge'

/**
 * Harnesses whose blocking gate ships SDK-side, in the harness's own
 * process — no on-disk hook/config file exists to point a gate at. Mirrors
 * the `file: null` NO_GATE rows in `gateRegistry.ts`.
 *
 * MASTRA, VERCEL_AI_SDK (T2), EVE (A2), and TRUEFORGE (embedded-library mode
 * only — see its own HarnessType doc) are the JS/TS-native members of this
 * family: their blocking gate ships in `@intutic/gate/mastra`/
 * `@intutic/gate/vercel`/`@intutic/gate/eve`/`@intutic/gate/trueforge`
 * (packages/gate-js) rather than `intutic-clawde`, but the shape is
 * identical — no on-disk hook/config file, tools run as plain callables in
 * the harness's own process (for eve, as per-tool/per-connection `approval`
 * policies attached in the agent directory's own TypeScript; for TrueForge,
 * as `intuticApprovalResponder()` answering `tool.approval_required`
 * pauses — see `@intutic/gate/trueforge`'s module doc for why that shape
 * differs from mastra/vercel's single-callback pattern).
 *
 * AI_SDK_HARNESS and AI_SDK_WORKFLOW (A3) are the same `@intutic/gate`
 * family with one nuance worth naming: the VETO still runs SDK-side in the
 * caller's own Node.js process (an approval responder / a `needsApproval`
 * function), which is what `'sdk'` classifies — but for AI_SDK_HARNESS the
 * tool EXECUTION it vetoes happens server-side in a Vercel Sandbox microVM,
 * and its built-in sandbox tools have no veto surface at all beyond
 * `permissionMode` (defaults to 'allow-all'). `'sdk'` describes where the
 * gate mechanism lives, not a claim that every tool the harness can run
 * passes through it — see gateRegistry.ts's NO_GATE rows for the honest
 * scope statement per harness.
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
  HarnessType.STRANDS,
  HarnessType.MASTRA,
  HarnessType.VERCEL_AI_SDK,
  HarnessType.EVE,
  HarnessType.TRUEFORGE,
  HarnessType.AI_SDK_HARNESS,
  HarnessType.AI_SDK_WORKFLOW,
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
 * `file: null` NO_GATE rows for `xirp` and `agentic-orchestrator` in
 * `gateRegistry.ts`. Xirp was the first entry of this shape; Agentic
 * Orchestrator (O3) is the second. O2 (QM) is expected to add a third, same
 * "wraps other harnesses" shape, in a concurrent phase not yet merged as of
 * this one.
 */
export const DELEGATED_GATE_HARNESSES: ReadonlySet<HarnessTypeT> = new Set([
  HarnessType.XIRP,
  HarnessType.AGENTIC_ORCHESTRATOR,
  // B2: AWS Bedrock AgentCore Runtime — hosts a customer's own framework
  // code unchanged; governed by whichever already-supported framework
  // adapter that code uses. See tools/cli/src/harness/agentcore.ts.
  HarnessType.AGENTCORE_RUNTIME,
])

/**
 * Harnesses whose blocking gate runs OUT OF PROCESS, in an Intutic-operated
 * service reacting to the harness's own async approval/event API — not a
 * file this daemon writes, and not an SDK imported into the harness's own
 * process (no process of ours runs inside the harness at all). Mirrors the
 * `file: null` NO_GATE row for `trueforge-server` in `gateRegistry.ts`.
 *
 * TRUEFORGE_SERVER (B3) is the first member: a TrueForge standalone/hosted
 * server has no in-process host to hang an SDK gate off of (contrast
 * TRUEFORGE, embedded mode, in `SDK_GATED_HARNESSES` above) — instead
 * `services/trueforge-bridge` watches its turn/event stream externally and
 * answers pending `tool.approval_required` pauses over HTTP. See the
 * `'bridge'` `GateKind` doc above for the full distinction from `'sdk'` and
 * `'delegated'`.
 */
export const BRIDGE_GATED_HARNESSES: ReadonlySet<HarnessTypeT> = new Set([HarnessType.TRUEFORGE_SERVER])

/** How this harness's tool calls get gated. Defaults to `'hook'`. */
export function gateKindForHarness(type: HarnessTypeT): GateKind {
  if (SDK_GATED_HARNESSES.has(type)) return 'sdk'
  if (NO_GATE_HARNESSES.has(type)) return 'none'
  if (DELEGATED_GATE_HARNESSES.has(type)) return 'delegated'
  if (BRIDGE_GATED_HARNESSES.has(type)) return 'bridge'
  return 'hook'
}
