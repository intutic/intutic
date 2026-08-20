/**
 * `@ai-sdk/harness` adapter: `intuticApprovalResponder()`, `intuticSubmitApprovals()`,
 * `intuticStaticApprovals()`, `recommendedHarnessSettings()`, and
 * `intuticSandboxBootstrap()`.
 *
 * `@intutic/gate/harness` — the same idea `vercel.ts` implements for the base
 * `ai` package (wrap the framework's own veto point around this package's
 * `Gate.guard()`), reshaped for Vercel's sandboxed coding-agent runtime,
 * whose veto surface is materially different from `generateText`'s.
 *
 * ## Confirmed against a real install
 *
 * `@ai-sdk/harness@1.0.75` (plus `@ai-sdk/harness-claude-code@1.0.78` and
 * `@ai-sdk/harness-grok-build@1.0.12`) were installed and their shipped
 * `.d.ts`/compiled source read directly (not inferred from docs alone):
 *
 * 1. **The `toolApproval` setting is STATIC.** `HarnessAgentSettings.toolApproval`
 *    is `HarnessAgentToolApprovalConfiguration = Readonly<Record<string,
 *    ToolApprovalStatus>>` (`dist/agent/index.d.ts`), whose own doc comment says
 *    it mirrors "AI SDK `toolApproval` object configuration for host-executed
 *    tools, **without callback support**". `vercel.ts`'s callback-shaped
 *    `intuticToolApproval()` therefore does NOT apply here — there is no place
 *    to hang a function. Per-call gating instead goes through the approval
 *    FLOW: mark tools `'user-approval'` (see {@link intuticStaticApprovals}),
 *    let the turn pause, and answer each pending approval with the gate
 *    (see {@link intuticApprovalResponder}).
 * 2. **The portable answer path is continuation-based.**
 *    `HarnessAgentToolApprovalContinuation` carries `{ approvalResponse,
 *    toolCall }`; `continueTurn`/`continueGenerate`/`continueStream` accept
 *    `toolApprovalContinuations` (dist/agent/index.d.ts). The adapter-session
 *    method `session.submitToolApproval?({approvalId, approved, reason})` is
 *    OPTIONAL (`dist/index.d.ts` — `HarnessV1PromptControl`), and support
 *    genuinely varies per adapter: `@ai-sdk/harness-claude-code@1.0.78`
 *    implements it; `@ai-sdk/harness-grok-build@1.0.12` does not (zero
 *    occurrences in its shipped dist). This module therefore builds the
 *    responder on the continuation path and treats `submitToolApproval` as an
 *    optimization when present ({@link intuticSubmitApprovals}).
 * 3. **Built-in sandbox tools are NOT governed by `toolApproval` at all.**
 *    They are governed only by `permissionMode: 'allow-reads' | 'allow-edits'
 *    | 'allow-all'`, which **defaults to `'allow-all'`** — the shipped doc
 *    comment says so verbatim: "Defaults to `'allow-all'`, preserving the
 *    existing bypass-permissions behavior unless users opt in." A HarnessAgent
 *    with default settings runs read/write/edit/bash/glob/grep in the sandbox
 *    with no approval step this gate could hook.
 *    {@link recommendedHarnessSettings} exists to steer callers off that
 *    default.
 * 4. **Execution is server-side, in a sandbox.** The agent's tools run inside
 *    a microVM (`@ai-sdk/sandbox-vercel` and friends), NOT on the machine
 *    where the Intutic proxy runs — the laptop proxy cannot see sandbox
 *    egress. The only egress control available at this layer is the sandbox's
 *    own `HarnessV1NetworkPolicy` (`{mode:'allow-all'|'deny-all'} | {mode:
 *    'custom', allowedHosts/allowedCIDRs/deniedCIDRs}`), applied via the
 *    sandbox session's optional `setNetworkPolicy?.()`. That is coarse
 *    host-level filtering, not Intutic DLP — stated plainly in
 *    `apps/docs/integrations/ai-sdk-harness.md` rather than oversold.
 *
 * ## What this module does NOT import
 *
 * Deliberately no runtime dependency on `@ai-sdk/harness` — the structural
 * types below capture only the shapes this adapter touches, matching the
 * convention `vercel.ts`/`mastra.ts`/`dsh.ts` established. The real package
 * is a devDependency used by `__tests__/harness.test.ts` to (a) structurally
 * check these types against the shipped ones and (b) run this responder's
 * output through the REAL `collectHarnessAgentToolApprovalContinuations`
 * machinery.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { active as activeGate, type Gate, type ToolInput } from './gate.js'
import { IntuticGateRefusal } from './errors.js'

/** Structural copy of `ai`'s `ToolApprovalResponse` prompt part (re-exported
 *  from `@ai-sdk/provider-utils@5.0.27` — confirmed field-for-field). This is
 *  the part a `role: 'tool'` message carries to answer an approval request. */
export interface HarnessToolApprovalResponse {
  type: 'tool-approval-response'
  approvalId: string
  approved: boolean
  reason?: string
  providerExecuted?: boolean
}

/** Structural copy of the `toolCall` member of `@ai-sdk/harness`'s
 *  `HarnessAgentToolApprovalContinuation` (dist/agent/index.d.ts). */
export interface HarnessToolCallPart {
  readonly type: 'tool-call'
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
  readonly providerExecuted?: boolean
}

/** Structural copy of `@ai-sdk/harness`'s `HarnessAgentToolApprovalContinuation`
 *  — the element type of the `toolApprovalContinuations` array
 *  `continueGenerate`/`continueStream` accept. */
export interface HarnessToolApprovalContinuation {
  readonly approvalResponse: HarnessToolApprovalResponse
  readonly toolCall: HarnessToolCallPart
}

/**
 * One pending tool-approval request, in the shape this responder consumes.
 *
 * Covers BOTH places a HarnessAgent surfaces one:
 *
 *   - the `tool-approval-request` stream/message parts of a running turn
 *     (paired with their `tool-call` parts — `input` is the parsed value), and
 *   - `HarnessAgentPendingToolApproval` rows from a suspended session, where
 *     `input` is a JSON **string** (confirmed: `HarnessV1PendingToolApproval.
 *     input: string` in `@ai-sdk/harness@1.0.75`'s dist/index.d.ts). String
 *     inputs are JSON-parsed before the gate evaluates them — see
 *     {@link renderHarnessToolInput}.
 */
export interface HarnessApprovalRequest {
  readonly approvalId: string
  readonly toolCallId: string
  readonly toolName: string
  /** Parsed input object, or the JSON string a pending-approval row carries. */
  readonly input: unknown
  readonly providerExecuted?: boolean
}

/** Structural copy of `@ai-sdk/harness`'s `HarnessV1PermissionMode`. */
export type HarnessPermissionMode = 'allow-reads' | 'allow-edits' | 'allow-all'

/** Structural copy of `@ai-sdk/harness`'s `HarnessV1NetworkPolicy`. The two
 *  `custom` branches of the real union each require at least one allow field;
 *  this single structural branch keeps both optional and relies on the test
 *  suite's assignability check against the real (stricter) type for the
 *  values this module itself constructs. */
export type HarnessNetworkPolicy =
  | { mode: 'allow-all' }
  | { mode: 'deny-all' }
  | {
      mode: 'custom'
      allowedHosts?: readonly string[]
      allowedCIDRs?: readonly string[]
      deniedCIDRs?: readonly string[]
    }

/** The slice of `@ai-sdk/harness`'s adapter-session control surface this
 *  module touches — `submitToolApproval` is OPTIONAL in the real
 *  `HarnessV1PromptControl` too, and per-adapter support varies (see module
 *  doc point 2). */
export interface HarnessSessionLike {
  submitToolApproval?(input: { approvalId: string; approved: boolean; reason?: string }): PromiseLike<void>
}

export interface IntuticApprovalResponderOptions {
  /** Overrides the process-wide installed gate (`install(new Gate(...))`). */
  gate?: Gate
}

/**
 * Render a pending approval's `input` as the `tool_input` object
 * {@link Gate.guard} evaluates.
 *
 * Mirrors `dsh.ts`'s `renderDshToolInput`, plus one harness-specific case: a
 * `HarnessAgentPendingToolApproval` carries its input as a JSON **string**,
 * so strings are parsed first. A string that does not parse (or parses to a
 * non-object) falls back to `{ args: [...] }` so the gate still has
 * something to evaluate rather than throwing on a shape it does not
 * recognise.
 */
export function renderHarnessToolInput(input: unknown): ToolInput {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { args: [input] }
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as ToolInput
  }
  return { args: [value] }
}

/** Parsed-if-possible view of a request's input, used on the continuation's
 *  `toolCall.input` so the shape matches what the tool call actually carried
 *  (a pending-approval row serializes it to a JSON string in transit). */
function parsedInput(input: unknown): unknown {
  if (typeof input !== 'string') return input
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}

/**
 * Build an approval responder: a function that evaluates each pending
 * tool-approval request via `Gate.guard()` and produces the
 * `toolApprovalContinuations` array for the continue-turn call —
 * `agent.continueGenerate({ session, toolApprovalContinuations })` /
 * `continueStream(...)`:
 *
 * ```ts
 * import { HarnessAgent } from '@ai-sdk/harness/agent'
 * import { Gate, install } from '@intutic/gate'
 * import {
 *   intuticApprovalResponder,
 *   intuticStaticApprovals,
 *   recommendedHarnessSettings,
 * } from '@intutic/gate/harness'
 *
 * install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))
 *
 * const agent = new HarnessAgent({
 *   harness,
 *   sandbox,
 *   tools,
 *   ...recommendedHarnessSettings(),           // permissionMode: 'allow-edits'
 *   toolApproval: intuticStaticApprovals(tools), // every custom tool -> 'user-approval'
 * })
 *
 * const respond = intuticApprovalResponder()
 * // ...run a turn; when it pauses awaiting approval, collect the pending
 * // tool-approval requests (stream parts or suspended-session rows), then:
 * const toolApprovalContinuations = await respond(pendingApprovals)
 * await agent.continueGenerate({ session, toolApprovalContinuations })
 * ```
 *
 * Decision mapping, per request:
 *
 *   - gate allows              -> `approved: true`
 *   - `IntuticGateRefusal`     -> `approved: false`, `reason` = the
 *     `[Intutic Governance] BLOCKED: ...` message (the runtime submits an
 *     `execution-denied` result to the model in place of a tool result)
 *   - any OTHER throw          -> `approved: false` with a "gate crashed"
 *     reason — **fail closed**, same posture as `dsh.ts`'s listener: this
 *     responder's output is a decision list consumed by a paused turn, and a
 *     deny is deliverable and auditable where an escaped throw could leave
 *     the turn suspended with no answer at all.
 *
 * Requires a `Gate` — either passed via `{ gate }`, or installed process-wide
 * with `install(new Gate(...))`. A call with neither rejects before
 * evaluating anything, refusing to answer approvals unguarded.
 */
export function intuticApprovalResponder(
  opts: IntuticApprovalResponderOptions = {},
): (requests: readonly HarnessApprovalRequest[]) => Promise<HarnessToolApprovalContinuation[]> {
  return async (requests) => {
    const g = opts.gate ?? activeGate()
    if (g === null) {
      throw new Error(
        'No gate configured: call install(new Gate(...)) from @intutic/gate, or pass ' +
          '{ gate } to intuticApprovalResponder(). Refusing to answer tool approvals unguarded.',
      )
    }

    const continuations: HarnessToolApprovalContinuation[] = []
    for (const req of requests) {
      let approved = true
      let reason: string | undefined
      try {
        await g.guard(req.toolName, renderHarnessToolInput(req.input))
      } catch (exc) {
        approved = false
        if (exc instanceof IntuticGateRefusal) {
          reason = exc.message
        } else {
          const detail = exc instanceof Error ? exc.message : String(exc)
          reason =
            `[Intutic Governance] BLOCKED: gate crashed (${detail}) — failing closed rather ` +
            'than approving an unevaluated call.'
        }
      }
      continuations.push({
        approvalResponse: {
          type: 'tool-approval-response',
          approvalId: req.approvalId,
          approved,
          ...(reason !== undefined ? { reason } : {}),
          ...(req.providerExecuted !== undefined ? { providerExecuted: req.providerExecuted } : {}),
        },
        toolCall: {
          type: 'tool-call',
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          input: parsedInput(req.input),
          ...(req.providerExecuted !== undefined ? { providerExecuted: req.providerExecuted } : {}),
        },
      })
    }
    return continuations
  }
}

export interface IntuticSubmitApprovalsResult {
  /** The evaluated decisions, always produced — pass these to
   *  `continueGenerate`/`continueStream` when `submitted` is false. */
  continuations: HarnessToolApprovalContinuation[]
  /** True when the session supported `submitToolApproval` and every decision
   *  was delivered through it; false when the caller must use the
   *  continuation path instead. */
  submitted: boolean
}

/**
 * Evaluate pending approvals and deliver the decisions through
 * `session.submitToolApproval` when the adapter supports it.
 *
 * `submitToolApproval` is an OPTIONAL adapter-session method and per-adapter
 * support varies (`harness-claude-code` implements it, `harness-grok-build`
 * does not — see module doc point 2). This helper treats it as an
 * optimization: when present, every decision is submitted directly (the turn
 * resumes in place); when absent, nothing is submitted and the caller passes
 * the returned `continuations` to `continueGenerate`/`continueStream` — the
 * portable path — instead. Either way the SAME evaluated decisions are
 * returned, so the caller never re-runs the gate for one delivery mechanism
 * vs. the other.
 */
export async function intuticSubmitApprovals(
  session: HarnessSessionLike,
  requests: readonly HarnessApprovalRequest[],
  opts: IntuticApprovalResponderOptions = {},
): Promise<IntuticSubmitApprovalsResult> {
  const continuations = await intuticApprovalResponder(opts)(requests)
  const submit = session.submitToolApproval?.bind(session)
  if (submit === undefined) {
    return { continuations, submitted: false }
  }
  for (const c of continuations) {
    await submit({
      approvalId: c.approvalResponse.approvalId,
      approved: c.approvalResponse.approved,
      ...(c.approvalResponse.reason !== undefined ? { reason: c.approvalResponse.reason } : {}),
    })
  }
  return { continuations, submitted: true }
}

export interface IntuticStaticApprovalsOptions {
  /** Tool names to mark `'denied'` unconditionally instead of
   *  `'user-approval'` — for tools that should never run under this agent
   *  regardless of what the gate would say about a specific call. */
  deny?: readonly string[]
}

/**
 * Build the static `toolApproval` record for `HarnessAgentSettings`.
 *
 * The record shape is `Readonly<Record<string, ToolApprovalStatus>>` — STATIC
 * per-tool statuses "without callback support" (the shipped doc comment's own
 * words), so a per-call gate function cannot be expressed here at all. What a
 * static record CAN express is deny-by-default **routing**: every listed tool
 * is marked `'user-approval'`, which pauses the turn on every call to it, and
 * {@link intuticApprovalResponder} then answers each pause with a real
 * per-call `Gate.guard()` verdict. `'denied'` is deliberately NOT the default
 * here — it would refuse every call to the tool unconditionally, without the
 * gate ever seeing the arguments; use `{ deny: [...] }` for tools where that
 * is actually what you want.
 *
 * Two scope limits, stated plainly:
 *
 *   - This covers CUSTOM host-executed tools only. Built-in sandbox tools
 *     (read/write/edit/bash/...) never consult `toolApproval` — they are
 *     governed solely by `permissionMode`, which defaults to `'allow-all'`.
 *     See {@link recommendedHarnessSettings}.
 *   - A tool absent from this record has status `undefined` =
 *     "not-applicable" and runs WITHOUT any approval pause. Pass the same
 *     `tools` record you give the agent (or every tool name), not a subset.
 */
export function intuticStaticApprovals(
  tools: readonly string[] | Record<string, unknown>,
  opts: IntuticStaticApprovalsOptions = {},
): Readonly<Record<string, 'user-approval' | 'denied'>> {
  const names = Array.isArray(tools) ? tools : Object.keys(tools)
  const denied = new Set(opts.deny ?? [])
  const record: Record<string, 'user-approval' | 'denied'> = {}
  for (const name of names) {
    record[name] = denied.has(name) ? 'denied' : 'user-approval'
  }
  return record
}

export interface RecommendedHarnessSettingsOptions {
  /** `'allow-reads'` is stricter (built-ins can read but not write); the
   *  default recommendation is `'allow-edits'` (read + write inside the
   *  sandbox, but not the unrestricted `'allow-all'` the framework itself
   *  defaults to). `'allow-all'` is deliberately not accepted here — asking
   *  this function for the framework's own bypass default would make the
   *  helper's name a lie. */
  permissionMode?: 'allow-reads' | 'allow-edits'
  /** Hosts sandbox egress should be limited to. When omitted, the
   *  recommended policy is `{ mode: 'deny-all' }` — deny-by-default until
   *  the caller decides what the sandbox legitimately needs to reach. */
  allowedHosts?: readonly string[]
  /**
   * Whether to also recommend excluding the sandbox's native `bash` builtin
   * from the tool set entirely, via `HarnessAgentSettings.inactiveTools`.
   * Defaults to `true` — see {@link RecommendedHarnessSettings.inactiveTools}
   * for what this does and does not guarantee (TD-415).
   */
  filterBash?: boolean
}

/** The exact policy shapes {@link recommendedHarnessSettings} constructs —
 *  narrower than {@link HarnessNetworkPolicy} so the value is assignable to
 *  the REAL `HarnessV1NetworkPolicy` union (whose `custom` branches each
 *  require an allow field) without a cast; the test suite pins that
 *  assignability against the shipped type. */
export type RecommendedNetworkPolicy =
  | { mode: 'deny-all' }
  | { mode: 'custom'; allowedHosts: readonly string[]; deniedCIDRs: readonly string[] }

export interface RecommendedHarnessSettings {
  /** Spread into `HarnessAgentSettings`. */
  permissionMode: 'allow-reads' | 'allow-edits'
  /**
   * NOT a `HarnessAgentSettings` field — apply it to the sandbox session via
   * its optional `setNetworkPolicy?.()` (e.g. from `sandboxConfig.onSession`),
   * or configure the equivalent on the sandbox provider. Optional-call it:
   * providers without a local enforcement primitive omit the method, and a
   * missing implementation means NO egress policy is applied at all — check
   * for `undefined` and treat that as an uncovered surface, not a silent ok.
   */
  networkPolicy: RecommendedNetworkPolicy
  /**
   * Spread into `HarnessAgentSettings.inactiveTools` — `undefined` when
   * `filterBash: false` was passed. TD-415, resolved with a corrected
   * understanding: `HarnessV1BuiltinToolFiltering` (the same package's own
   * type, `dist/index.d.ts`/`dist/agent/index.d.ts`) genuinely CAN drop
   * `bash` at config time, confirmed against real shipped `dist/index.js`
   * for both harnesses TD-417 discusses (not just their `.d.ts` — the
   * behaviour lives in compiled logic no type file states):
   *
   *   - `@ai-sdk/harness-claude-code@1.0.78` sets BOTH
   *     `supportsBuiltinToolApprovals: true` AND
   *     `supportsBuiltinToolFiltering: true` on its adapter object, and its
   *     `doStart`/`doContinueTurn` forward `builtinToolFiltering` verbatim
   *     onto the bridge `start`/`continue` message — true native exclusion,
   *     enforced by the wrapped Claude Agent SDK inside the sandbox itself,
   *     not merely a framework-side veto. `bash` never becomes callable.
   *   - `@ai-sdk/harness-grok-build@1.0.12` sets neither flag directly, but
   *     is built on `@ai-sdk/harness-acp@1.0.13` (its exact pinned
   *     dependency, confirmed via `npm pack`), which sets
   *     `supportsBuiltinToolApprovals: true` (and
   *     `supportsBuiltinToolFiltering: false`) — so Grok Build gets the
   *     FRAMEWORK's own fallback instead: `@ai-sdk/harness/agent`'s compiled
   *     `resolveHarnessAgentToolFiltering` (`dist/agent/index.js`) routes
   *     every inactive-builtin call through the approval path and
   *     auto-denies it before execution. Different mechanism, same practical
   *     outcome — `bash` is still never executed.
   *   - Confirmed further: if an adapter supported NEITHER flag, the
   *     framework does not silently ignore `inactiveTools` for a builtin —
   *     `HarnessAgent`'s constructor throws `HarnessCapabilityUnsupportedError`
   *     (`dist/agent/index.js`) rather than accepting a setting it cannot
   *     honour. So this recommendation is never a silent no-op for any
   *     adapter that accepts it at all.
   *
   * What this does NOT close: TD-415's original per-call gap. This is a
   * coarse, all-or-nothing exclusion decided once at session-construction
   * time — never a `Gate.guard()`-evaluated verdict per call, and a
   * workspace that genuinely needs `bash` available cannot use this
   * filtering and is back to the original `permissionMode` gap for it.
   */
  inactiveTools?: readonly ['bash']
}

/**
 * The settings posture this integration recommends, as a value callers can
 * spread/apply rather than prose they have to transcribe:
 *
 *   - `permissionMode: 'allow-edits'` (or `'allow-reads'`) — because the
 *     framework's own default is `'allow-all'`, under which built-in sandbox
 *     tools (including `bash`) run with no approval surface this gate can
 *     reach. There is no per-call gate for built-ins at ANY permissionMode;
 *     the mode itself is the entire control, which is why steering it off
 *     `'allow-all'` matters.
 *   - a `networkPolicy` for the sandbox — `{ mode: 'deny-all' }` by default,
 *     or a `custom` allow-list (with the cloud-metadata CIDR denied) when
 *     `allowedHosts` is given. This is the honest egress-governance story for
 *     server-side sandbox execution: the Intutic proxy on the developer's
 *     machine never sees sandbox traffic, and host-level filtering is what
 *     the sandbox layer actually offers. It is coarse — no DLP, no
 *     per-request policy — and the integration docs say so.
 */
export function recommendedHarnessSettings(
  opts: RecommendedHarnessSettingsOptions = {},
): RecommendedHarnessSettings {
  const networkPolicy: RecommendedNetworkPolicy =
    opts.allowedHosts !== undefined && opts.allowedHosts.length > 0
      ? {
          mode: 'custom',
          allowedHosts: opts.allowedHosts,
          // Cloud metadata endpoint — deny it even when the caller's allow
          // list is broad; deniedCIDRs wins over allows in the real policy.
          deniedCIDRs: ['169.254.169.254/32'],
        }
      : { mode: 'deny-all' }
  return {
    permissionMode: opts.permissionMode ?? 'allow-edits',
    networkPolicy,
    ...(opts.filterBash === false ? {} : { inactiveTools: ['bash'] as const }),
  }
}

// ============================================================================
// Sandbox bootstrap — TD-417 Half A
// ============================================================================
//
// `recommendedHarnessSettings()` and `intuticApprovalResponder()` above cover
// the framework-level surface: `permissionMode`, `toolApproval`/the
// continuation flow, and `networkPolicy`. None of that reaches Claude Code's
// OWN native PreToolUse gate — the one the sync-daemon writes on a developer
// laptop (`services/sync-daemon/src/harness/claudeCodeHooks.ts`, generating
// `.intutic/hooks/claude-code-check.js` + `.claude/settings.json`). Inside a
// `@ai-sdk/harness` sandbox there is no laptop for the sync-daemon to write
// to, so that native gate is simply absent (TD-417's core finding).
//
// ## The channel — confirmed against a real install, not assumed
//
// `HarnessAgentSandboxConfig` (`@ai-sdk/harness/agent@1.0.75`'s shipped
// `dist/agent/index.d.ts`) is a real, documented, TYPED consumer-facing
// bootstrap hook — distinct from `HarnessV1.getBootstrap`, which is the
// ADAPTER's own (e.g. Claude Code's) private bootstrap recipe, not something
// a consumer of this package sets:
//
// ```ts
// type HarnessAgentSandboxConfig = {
//   readonly workDir?: string
//   readonly bootstrapHash?: string
//   readonly onBootstrap?: (opts: {
//     readonly session: Experimental_SandboxSession
//     readonly workDir: string
//     readonly abortSignal?: AbortSignal
//   }) => Promise<void>
//   readonly onSession?: (opts: {
//     readonly session: Experimental_SandboxSession
//     readonly sessionWorkDir: string
//     readonly abortSignal?: AbortSignal
//   }) => Promise<void>
// }
// ```
//
// `onBootstrap` "is called during sandbox template creation after the
// harness adapter's own bootstrap has run and before snapshot-capable
// providers publish a snapshot" (the shipped doc comment, verbatim) — i.e.
// it fires ONCE per `bootstrapHash` identity, its side effects get baked
// into a reusable snapshot, and later sessions reusing that snapshot never
// re-run it. That is exactly the right lifecycle for STATIC governance
// files (a hook script + a settings file), which is why
// {@link intuticSandboxBootstrap} uses `onBootstrap` alone and does not need
// `onSession` (reserved for genuinely per-session state, which this module
// has none of at this scope).
//
// ## What `intuticSandboxBootstrap()` writes, and why it is NOT a byte copy
// of the laptop artifacts
//
// The laptop's `claude-code-check.js` (`emitJsGate`/`emitPreImageCapture`/
// `emitJsFailClosedPrelude` in `services/sync-daemon/src/harness/gateBody.ts`)
// implements FOUR tiers: the policy-snapshot floor (A1), SOP rules fetched
// live from the control plane (A3), review-hold parking, and fire-and-forget
// event draining to the control plane over HTTPS. `services/sync-daemon` is
// a private service package this public package must not depend on (see
// `snapshot.ts`'s module doc for the same constraint, already established
// for the `.rules` reader), and three of those four tiers need something a
// sandbox-bootstrap function fundamentally cannot have at construction time:
// a live control-plane connection (A3, review-hold, draining), which
// `recommendedHarnessSettings()`'s own `networkPolicy` recommends denying by
// default anyway.
//
// What DOES port cleanly, with no live connection and no cross-package
// import: Tier A1, the policy-snapshot evaluator. `snapshot.ts` in THIS
// package already implements it (`normalise`/`evaluate`), tested for
// fidelity against the real pattern tables in `fidelity.test.ts`. The hook
// script below is a self-contained (zero-`require`) hand-port of that same
// algorithm — same field order, same padding/case-sensitivity contract, same
// severity precedence — so it can run as a standalone Node script inside the
// sandbox with no npm install step (which the recommended `deny-all` network
// policy would block anyway). `__tests__/harness.test.ts` proves this port
// behaviourally, not just by inspection: it spawns the exact generated
// script as a child process against `allFloorFixtures()` cases and asserts
// its exit code agrees with `snapshot.evaluate()`'s verdict for the same
// rule.
//
// Deliberately NOT reproduced here, and said so rather than silently
// dropped: the SOP tier (A3), review-hold parking, and control-plane event
// draining. A workspace relying on this bootstrap for sandbox coverage gets
// the destructive-command floor and any SOP-authored rules already compiled
// into the `.rules` text it supplies — a real but strict SUBSET of the
// laptop gate, the same kind of documented gap `gate.ts`'s own module doc
// already calls out for this package's Tier A1 relative to a shipped
// harness gate.
//
// ## Scope: Claude Code only
//
// `.claude/settings.json`'s `hooks.PreToolUse` shape is Claude Code's own
// contract. Grok Build's laptop equivalent
// (`services/sync-daemon/src/harness/grokHooks.ts`) uses a completely
// different mechanism — a `.grok/hooks/*.json` registry entry, a
// `{"decision":"deny","reason":"..."}`-on-stdout block contract instead of
// an exit code, and no adapter `env` passthrough at all (confirmed absent
// from `GrokBuildHarnessSettings`, `dist/index.d.ts`, `@ai-sdk/harness-grok-
// build@1.0.12`) — building that is real follow-up work, not attempted here.
// Bootstrap-file injection (this channel) would still be Grok Build's ONLY
// viable path, for the same reason it is Claude Code's: `env` does not
// matter to this approach either way, since `onBootstrap` writes into the
// sandbox filesystem directly, independent of adapter settings.
//
// ## What remains unverified (Half C, explicitly out of scope here)
//
// Whether the bridge inside a REAL sandbox actually runs this script as a
// PreToolUse hook, whether the written files survive a snapshot/resume
// cycle, and whether a `process.exit(2)` from this script genuinely stops
// the tool call from the model's point of view — none of that is
// verifiable without a live Vercel Sandbox deployment. See TD-417's updated
// entry.

/** Structural copy of `@ai-sdk/provider-utils`'s `SandboxSession`, narrowed
 *  to the one method {@link intuticSandboxBootstrap}'s `onBootstrap` calls.
 *  Confirmed field-for-field against `@ai-sdk/provider-utils@5.0.27`'s
 *  shipped `dist/index.d.ts` (`WriteFileOptions<string>` plus its own
 *  `encoding` addition on `writeTextFile`). */
export interface SandboxWriteSession {
  writeTextFile(options: { path: string; content: string; encoding?: string }): PromiseLike<void>
}

/** Structural copy of `@ai-sdk/harness/agent`'s
 *  `HarnessAgentSandboxConfig['onBootstrap']` parameter shape
 *  (`dist/agent/index.d.ts`), narrowed to the fields this module reads. */
export interface SandboxBootstrapCallbackOptions {
  readonly session: SandboxWriteSession
  readonly workDir: string
  readonly abortSignal?: AbortSignal
}

export interface IntuticSandboxBootstrap {
  /** Pass through unchanged to `HarnessAgentSettings.sandboxConfig.bootstrapHash`
   *  — required alongside `onBootstrap` by the real type. Deterministic: the
   *  same options always produce the same hash, and a snapshot-capable
   *  sandbox provider uses it to decide whether `onBootstrap` needs to run
   *  again. Computed the same way `snapshot.ts` computes the policy-snapshot
   *  digest — `createHash('sha256')` over the recipe content, this module's
   *  own existing hashing convention, not a new one. */
  readonly bootstrapHash: string
  /** Pass through unchanged to `HarnessAgentSettings.sandboxConfig.onBootstrap`. */
  readonly onBootstrap: (opts: SandboxBootstrapCallbackOptions) => Promise<void>
}

export interface IntuticSandboxBootstrapOptions {
  /**
   * Compiled `.rules` text — the SAME artifact format `snapshot.ts` reads
   * (`~/.intutic/hooks/policy-snapshot.rules` on a laptop). Copy the file
   * content in, e.g. by reading it from the host running the orchestrator
   * code before constructing this bootstrap. Omit to ship a hook script that
   * loads zero rules (still present as a channel, evaluating nothing) —
   * never silently skipped, so a missing snapshot shows up as an empty file
   * inside the sandbox rather than a missing one.
   */
  policySnapshotRules?: string
  /** Embedded in the recipe hash only (so a workspace switch invalidates a
   *  cached snapshot) — this module does not otherwise use it, matching
   *  `snapshot.ts`'s reader, which also treats workspace id as an integrity
   *  check rather than a lookup key. */
  workspaceId?: string
  /** Directory inside the sandbox (relative to `workDir`) the hook script
   *  and its rules file are written under. Defaults to `.intutic/hooks`,
   *  the same relative location the laptop writer uses. */
  bootstrapDir?: string
}

function sandboxJoin(workDir: string, relative: string): string {
  const base = workDir.endsWith('/') ? workDir.slice(0, -1) : workDir
  return `${base}/${relative}`
}

/**
 * Self-contained (zero-`require`) hand-port of `snapshot.ts`'s
 * `normalise`/`evaluate` — Tier A1 only. See the module-level comment above
 * for what this deliberately does and does not cover, and
 * `__tests__/harness.test.ts` for the behavioural-parity check against the
 * real `snapshot.evaluate()` this port is pinned to.
 *
 * Contract matches the laptop's `claude-code-check.js`
 * (`services/sync-daemon/src/harness/claudeCodeHooks.ts`) deliberately:
 * Claude Code's PreToolUse hook stdin carries `{tool_name, tool_input,
 * session_id}` (this reads both the snake_case and camelCase field names,
 * same as the laptop script); exit `2` blocks the call, exit `0` allows it;
 * any parse/read error fails CLOSED (exit `2`), the same posture
 * `emitJsFailClosedPrelude` documents for the laptop's version.
 */
function renderSandboxGateScript(rulesFileName: string): string {
  return `#!/usr/bin/env node
'use strict';
/**
 * Intutic sandbox PreToolUse gate (Tier A1 only — policy-snapshot rules).
 * Auto-generated by @intutic/gate's intuticSandboxBootstrap(). DO NOT EDIT.
 *
 * Unlike the laptop's claude-code-check.js, this script has no live
 * control-plane connection at call time (the recommended sandbox network
 * policy is deny-all) and therefore implements NEITHER the SOP tier (A3)
 * NOR review-hold parking NOR governance-event draining. See TD-417.
 */
const fs = require('fs');
const path = require('path');

const RULES_PATH = path.join(__dirname, ${JSON.stringify(rulesFileName)});

function normalise(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return ' ' + s.replace(/\\s+/g, ' ').trim() + ' ';
}

function loadRules() {
  let text;
  try {
    text = fs.readFileSync(RULES_PATH, 'utf-8');
  } catch (e) {
    return [];
  }
  const rules = [];
  for (const line of text.split('\\n')) {
    if (!line || line.charAt(0) === '#') continue;
    const f = line.split('\\t');
    if (f.length < 6 || !f[5]) continue;
    try {
      rules.push({
        id: f[0],
        severity: f[1],
        subject: f[3] || 'any',
        reason: f[4],
        pattern: new RegExp(f[5], f[2] === 'i' ? 'i' : ''),
      });
    } catch (e) {
      // Regex would not compile — dropped, not fatal. Matches snapshot.ts.
    }
  }
  return rules;
}

function evaluate(toolName, target, command, rules) {
  const nTool = normalise(toolName);
  const nCommand = normalise(command);
  const nTarget = normalise(target);
  for (const rule of rules) {
    const subjects =
      rule.subject === 'tool' ? [nTool] :
      rule.subject === 'command' ? [nCommand] :
      rule.subject === 'target' ? [nTarget] :
      [nCommand, nTarget];
    for (const subject of subjects) {
      if (!rule.pattern.test(subject)) continue;
      return { severity: rule.severity, reason: rule.reason + ' [' + rule.id + ']' };
    }
  }
  return null;
}

let inputData = '';
process.stdin.on('data', (chunk) => { inputData += chunk; });
process.stdin.on('end', () => {
  try {
    const ctx = JSON.parse(inputData || '{}');
    const toolName = ctx.tool_name || ctx.toolName || '';
    const toolInput = ctx.tool_input || ctx.toolInput || {};
    const target = toolInput.path || toolInput.file_path || toolInput.filePath ||
      toolInput.new_path || toolInput.target || toolInput.notebook_path || '';
    const command = String(toolInput.command || toolInput.cmd || toolInput.script || '');
    const rules = loadRules();
    const decision = evaluate(toolName, target, command, rules);
    if (decision && decision.severity === 'block') {
      console.error('[Intutic Guardrail] BLOCKED: ' + decision.reason);
      process.exit(2);
    }
    if (decision && (decision.severity === 'warn' || decision.severity === 'shadow')) {
      console.error('[Intutic Guardrail] FLAGGED (' + decision.severity + '): ' + decision.reason);
    }
    process.exit(0);
  } catch (err) {
    // Fail CLOSED — any hook execution error blocks the tool call, the same
    // posture emitJsFailClosedPrelude documents for the laptop script.
    console.error('[Intutic Guardrail] Hook error (blocking for safety):', err && err.message ? err.message : err);
    process.exit(2);
  }
});
`
}

/**
 * Compiles the `.claude/settings.json` content that registers the generated
 * hook script — same matcher set and hook shape as the laptop writer's
 * `hookEntry()` (`services/sync-daemon/src/harness/claudeCodeHooks.ts`):
 * `Bash`, `Edit`, `Write`, `MultiEdit`, and `mcp__.*`.
 */
function renderSandboxClaudeSettings(hookScriptSandboxPath: string): string {
  const hookEntry = (matcher: string) => ({
    matcher,
    hooks: [
      {
        type: 'command',
        command: `node ${hookScriptSandboxPath}`,
        timeout: 10,
        statusMessage: 'Verifying tool execution against Intutic SOP policy...',
      },
    ],
  })
  const settings = {
    permissions: { deny: [] as string[] },
    hooks: {
      PreToolUse: [hookEntry('Bash'), hookEntry('Edit'), hookEntry('Write'), hookEntry('MultiEdit'), hookEntry('mcp__.*')],
    },
  }
  return JSON.stringify(settings, null, 2) + '\n'
}

/**
 * Builds `{ bootstrapHash, onBootstrap }` for
 * `HarnessAgentSettings.sandboxConfig` — the channel TD-417 identified as
 * existing but unused:
 *
 * ```ts
 * import { HarnessAgent } from '@ai-sdk/harness/agent'
 * import { intuticSandboxBootstrap, recommendedHarnessSettings } from '@intutic/gate/harness'
 *
 * const agent = new HarnessAgent({
 *   harness,
 *   sandbox,
 *   ...recommendedHarnessSettings(),
 *   sandboxConfig: intuticSandboxBootstrap({
 *     policySnapshotRules: fs.readFileSync(snapshotPath(), 'utf-8'),
 *     workspaceId: process.env.INTUTIC_WORKSPACE_ID,
 *   }),
 * })
 * ```
 *
 * Writes two files under `<workDir>/<bootstrapDir>` (default
 * `.intutic/hooks`) — the rules text verbatim, and a self-contained hook
 * script implementing Tier A1 against it (see
 * {@link renderSandboxGateScript}) — plus `.claude/settings.json` at
 * `<workDir>/.claude/settings.json` registering that script as a
 * `PreToolUse` hook. See the module-level comment above this section for
 * what this does and does not cover, and why.
 */
export function intuticSandboxBootstrap(opts: IntuticSandboxBootstrapOptions = {}): IntuticSandboxBootstrap {
  const bootstrapDir = opts.bootstrapDir ?? '.intutic/hooks'
  const rulesRelPath = `${bootstrapDir}/policy-snapshot.rules`
  const scriptRelPath = `${bootstrapDir}/claude-code-check.js`

  const rulesContent = opts.policySnapshotRules ?? ''
  const scriptContent = renderSandboxGateScript('policy-snapshot.rules')

  // Same hashing convention `snapshot.ts` already uses for the policy
  // digest (`createHash('sha256')` from node:crypto) — not a new mechanism.
  const bootstrapHash = createHash('sha256')
    .update(`workspace:${opts.workspaceId ?? ''} `)
    .update(`${rulesRelPath}\x00${rulesContent}\x00${scriptRelPath}\x00${scriptContent}`)
    .digest('hex')

  return {
    bootstrapHash,
    onBootstrap: async ({ session, workDir }) => {
      // Absolute paths throughout, matching the laptop writer's own
      // convention (claudeCodeHooks.ts's hookEntry() always joins an
      // absolute workspaceRoot) - a PreToolUse hook's invocation cwd is not
      // guaranteed to be workDir, so a relative command would be fragile.
      const scriptAbsPath = sandboxJoin(workDir, scriptRelPath)
      const files: ReadonlyArray<{ path: string; content: string }> = [
        { path: sandboxJoin(workDir, rulesRelPath), content: rulesContent },
        { path: scriptAbsPath, content: scriptContent },
        { path: sandboxJoin(workDir, '.claude/settings.json'), content: renderSandboxClaudeSettings(scriptAbsPath) },
      ]
      for (const f of files) {
        await session.writeTextFile({ path: f.path, content: f.content })
      }
    },
  }
}

// Exposed for the behavioural-parity test — not part of the public surface.
export const _internal = { renderSandboxGateScript, renderSandboxClaudeSettings, sandboxJoin }
