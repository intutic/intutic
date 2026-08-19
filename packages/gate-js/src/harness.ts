/**
 * `@ai-sdk/harness` adapter: `intuticApprovalResponder()`, `intuticSubmitApprovals()`,
 * `intuticStaticApprovals()`, and `recommendedHarnessSettings()`.
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
  }
}
