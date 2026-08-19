/**
 * eve adapter: `intuticApproval()`, `intuticConnectionApproval()`,
 * `intuticAuditHooks()`.
 *
 * `@intutic/gate/eve` — a framework-specific specialization of the same idea
 * `wrapTools.ts` implements generically (see that file's module doc): wrap the
 * framework's own veto point around this package's `Gate.guard()`.
 *
 * eve (npm `eve`, github.com/vercel/eve) is Vercel's filesystem-first
 * framework for durable backend AI agents: an agent is a directory (`agent/`
 * with `instructions.md`, `agent/tools/*.ts`, `agent/connections/*.ts`,
 * `agent/hooks/*.ts`, ...) that eve builds by walking the tree. It is a
 * pre-1.0 PREVIEW product (0.39.1 at the time of writing, very active) —
 * see docs/TECH_DEBT.md TD-410 for the churn shield this adapter carries,
 * the same posture the dsh integration established.
 *
 * ## The veto mechanism — CONFIRMED against a real install, not assumed
 *
 * `eve@0.39.1` is installed as a devDependency of this package and its
 * shipped `.d.ts` files were read directly (not inferred from docs alone).
 * eve's per-tool veto point is the `approval` property on a tool definition
 * (`dist/src/public/definitions/tool.d.ts`), and the same `Approval` type is
 * accepted per-connection by `defineMcpClientConnection` /
 * `defineOpenAPIConnection` (`dist/src/public/definitions/connections/
 * {mcp,openapi}.d.ts`), gating ALL of that connection's tools. There is NO
 * agent-level default approval field (`agent.d.ts` carries zero approval
 * fields — verified) — attaching a shared policy per tool/connection is
 * eve's own documented multi-tenant pattern
 * (`docs/patterns/multi-tenant-approvals.md`), and exactly the shape this
 * adapter exports.
 *
 * The confirmed policy contract (`dist/src/public/definitions/approval.d.ts`):
 *
 * ```ts
 * export interface ApprovalContext<TInput = Record<string, unknown>> extends SessionContext {
 *   readonly approvedTools: ReadonlySet<string>
 *   readonly callId: string
 *   readonly toolInput?: ApprovalToolInput<TInput>   // Readonly<TInput> | TInput; CAN be undefined
 *   readonly toolName: string
 * }
 * export type ApprovalStatus = undefined | boolean
 *   | 'not-applicable' | 'approved' | 'denied' | 'user-approval'
 *   | { readonly type: 'not-applicable'; readonly reason?: never }
 *   | { readonly type: 'approved'; readonly reason?: string }
 *   | { readonly type: 'denied'; readonly reason?: string }
 *   | { readonly type: 'user-approval'; readonly reason?: never }
 * export type ApprovalPolicy<TInput = Record<string, unknown>> =
 *   (ctx: ApprovalContext<TInput>) => ApprovalStatus | Promise<ApprovalStatus>
 * ```
 *
 * These are AI SDK 7 approval statuses (eve is built on `ai` v7 — the same
 * family `vercel.ts` documents). `'denied'` / `{ type: 'denied', reason }`
 * vetoes the call before execution; `reason` reaches the model in place of a
 * tool result. `'not-applicable'` (and `undefined`) means "continue without a
 * prompt"; `'user-approval'` parks the run durably for a human. The boolean
 * forms are back-compat for eve's earlier predicate shape: `true` is treated
 * as `'user-approval'` and `false` as `'not-applicable'` (confirmed in
 * `docs/tools/human-in-the-loop.md`) — this adapter never RETURNS booleans,
 * but its structural {@link EveApprovalStatus} copy includes them so the type
 * stays field-for-field faithful to the real union.
 *
 * ## Allow-shape: why `'not-applicable'` and not `'approved'`
 *
 * Unlike the Vercel AI SDK's `toolApproval` (a separate, whole-run config
 * that coexists with per-tool mechanisms), eve's `approval` IS the tool's one
 * approval policy — whatever this function returns is the whole decision for
 * that call. On allow this adapter returns `'not-applicable'` by default:
 * eve's own "no prompt needed, continue" value, matching the semantics of an
 * omitted `approval` (`never()`). It deliberately does NOT return
 * `'approved'`: that value asserts an affirmative approval decision this gate
 * did not make (Intutic's allow is "no objection", not "signed off"), and its
 * interaction with eve's `approvedTools` bookkeeping (`once()` keys off that
 * set) is not something this adapter verified. Callers who want eve's human
 * flow ON TOP of the governance gate set `{ onAllow: 'user-approval' }` —
 * "governance has no objection; still ask a person" — or compose manually
 * (see {@link intuticApproval}).
 *
 * ## Audit hooks — observe-only, and honestly scoped
 *
 * eve's hook surface (`agent/hooks/*.ts`, `dist/src/public/definitions/
 * hook.d.ts`) exposes `approval.candidate` / `approval.settled` stream
 * events. Handlers are OBSERVE-ONLY by eve's own contract ("fire after eve
 * has accepted and durably recorded each event ... cannot inject model
 * context") — {@link intuticAuditHooks} is telemetry, not enforcement; the
 * enforcement surface is {@link intuticApproval}. LOAD-BEARING caveat,
 * verified against `dist/src/protocol/message.d.ts`: these two events carry
 * `requestId`/`responderPrincipalId`/`turnId`/`stepIndex` but NOT the tool
 * name or input, so the emitted Intutic events attribute to the synthetic
 * tool name {@link EVE_APPROVAL_TOOL_NAME} with the request id in the reason
 * — request-scoped attribution, not tool-scoped. See TD-411.
 *
 * ## LLM egress — documented honestly, not oversold
 *
 * eve routes models through the Vercel AI Gateway by default (a gateway model
 * id string in `agent.ts`'s `defineAgent({ model })`, `AI_GATEWAY_API_KEY` /
 * `VERCEL_OIDC_TOKEN` credentials — confirmed in `docs/agent-config.md` and
 * `docs/getting-started.mdx`). The AI Gateway wire protocol is NOT something
 * the Intutic proxy parses, so gateway-routed egress is ungoverned by the
 * proxy — full stop, and TD-412 tracks it. The governable path is eve's
 * other documented option: passing a provider-authored `LanguageModel`
 * (`createOpenAI(...)` etc.) to `defineAgent({ model })`, where the
 * `withIntuticProxy()` helper — implemented once in `vercel.ts` and
 * re-exported here — applies exactly as it does for the plain Vercel AI SDK.
 * As with that framework, there is no env-var base-URL override: routing is
 * in-code, per provider-construction call site.
 *
 * @module
 */

import { active as activeGate, type Gate } from './gate.js'
import type { ToolInput } from './gate.js'
import { GateClient } from './client.js'
import { IntuticGateRefusal } from './errors.js'

// One routing story, one implementation: eve's direct-provider path is the
// Vercel AI SDK's (eve is built on `ai` v7), so the helper is re-exported
// rather than duplicated. See vercel.ts for the full module doc.
export { intuticProxyUrl, withIntuticProxy } from './vercel.js'

/** Synthetic tool name used by {@link intuticAuditHooks} — eve's
 *  `approval.candidate`/`approval.settled` events do not carry the real tool
 *  name (verified against `dist/src/protocol/message.d.ts`; see module doc). */
export const EVE_APPROVAL_TOOL_NAME = 'eve:approval'

/** Structural copy of eve's `ApprovalStatus` — this package does not depend
 *  on `eve` at runtime, so the shape is declared here rather than imported.
 *  Confirmed field-for-field against `eve@0.39.1`'s
 *  `dist/src/public/definitions/approval.d.ts` (see module doc), including
 *  the boolean back-compat forms this adapter itself never returns. */
export type EveApprovalStatus =
  | undefined
  | boolean
  | 'not-applicable'
  | 'approved'
  | 'denied'
  | 'user-approval'
  | { readonly type: 'not-applicable'; readonly reason?: never }
  | { readonly type: 'approved'; readonly reason?: string }
  | { readonly type: 'denied'; readonly reason?: string }
  | { readonly type: 'user-approval'; readonly reason?: never }

/** Structural copy of the slice of eve's `ApprovalContext` this adapter
 *  reads (`toolName`, `toolInput`). The real context is wider — it extends
 *  `SessionContext` and also carries `approvedTools`/`callId` — so the real
 *  type is assignable to this one, which is what makes a policy declared
 *  against this slice assignable to eve's own `ApprovalPolicy`. */
export interface EveApprovalContext {
  /** Final runtime tool name. Path-derived for authored tools
   *  (`agent/tools/refund_charge.ts` → `refund_charge`); QUALIFIED for
   *  connection tools (`billing__updateSubscription`) — see
   *  {@link intuticConnectionApproval}. */
  readonly toolName: string
  /** Parsed tool input. eve documents this CAN be undefined; a non-object is
   *  also possible for non-record input schemas — see
   *  {@link renderEveToolInput}'s handling. */
  readonly toolInput?: unknown
}

/** The policy function shape this adapter returns — assignable to eve's
 *  `ApprovalPolicy` (and therefore to a tool definition's `approval` field
 *  and a connection's `approval` field, both of which accept `Approval =
 *  ApprovalPolicy | ApprovalConfiguration`). */
export type EveApprovalPolicy = (ctx: EveApprovalContext) => Promise<EveApprovalStatus>

export interface IntuticApprovalOptions {
  /** Overrides the process-wide installed gate (`install(new Gate(...))`). */
  gate?: Gate
  /**
   * Status returned when the gate ALLOWS the call.
   *
   * - `'not-applicable'` (default): continue without a human prompt — eve's
   *   own "no prompt needed" value, the same behaviour as an omitted
   *   `approval` (`never()`). Use when Intutic governance is the only
   *   approval layer this tool needs.
   * - `'user-approval'`: park the run durably for a person even though
   *   governance has no objection — the "governance gate + human sign-off"
   *   stack, equivalent to composing with eve's `always()`.
   *
   * `'approved'` is deliberately not offered — see the module doc's
   * "Allow-shape" section. For anything more conditional (e.g. eve's
   * `once()`, or your own tenant policy), compose manually:
   *
   * ```ts
   * import { once } from 'eve/tools/approval'
   * const intutic = intuticApproval()
   * // inside defineTool({ ... }):
   * approval: async (ctx) => {
   *   const verdict = await intutic(ctx)
   *   if (typeof verdict === 'object' && verdict?.type === 'denied') return verdict
   *   return once()(ctx) // your own flow decides the rest
   * },
   * ```
   */
  onAllow?: 'not-applicable' | 'user-approval'
}

/**
 * Render an eve `toolInput` as the `tool_input` object {@link Gate.guard}
 * evaluates.
 *
 * Mirrors dsh.ts's `renderDshToolInput` (same reasoning as its own mirror of
 * `wrapTools.ts`'s non-exported `renderToolInput`): a plain object passes
 * through as-is; `undefined` (which eve documents as possible — "toolInput
 * can be undefined, so guard the access") becomes `{}`; any other non-object
 * value falls back to `{ args: [...] }` so the gate still has something to
 * evaluate.
 */
function renderEveToolInput(input: unknown): ToolInput {
  if (input === undefined) return {}
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as ToolInput
  }
  return { args: [input] }
}

/**
 * Builds an approval policy matching eve's `ApprovalPolicy` signature, for
 * direct use as a tool definition's `approval` field:
 *
 * ```ts
 * // agent/tools/refund_charge.ts
 * import { defineTool } from 'eve/tools'
 * import { z } from 'zod'
 * import { intuticApproval } from '@intutic/gate/eve'
 *
 * export default defineTool({
 *   description: 'Refund a charge.',
 *   inputSchema: z.object({ chargeId: z.string(), amount: z.number() }),
 *   approval: intuticApproval(),
 *   async execute(input) {
 *     return refund(input)
 *   },
 * })
 * ```
 *
 * (Install the gate once, process-wide, e.g. in `agent.ts`:
 * `install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))`.)
 *
 * Resolves to `'not-applicable'` on allow (or `opts.onAllow` — see
 * {@link IntuticApprovalOptions.onAllow}) and to `{ type: 'denied', reason }`
 * on refusal — `reason` is the `[Intutic Governance] BLOCKED: ...` message,
 * handed back to the model in place of a tool result; the tool's `execute`
 * never runs.
 *
 * Requires a `Gate` — either passed via `{ gate }` here, or installed
 * process-wide with `install(new Gate(...))`. A call with neither throws,
 * refusing to run the tool unguarded rather than silently skipping
 * enforcement — same posture as `wrapTool`/`intuticHooks`/
 * `intuticToolApproval`. A non-refusal crash inside the gate is re-thrown
 * rather than mapped to a denial — eve's own approval docs direct policies to
 * "throw or deny, never silently allow", and a thrown policy fails the turn
 * (fail closed), matching vercel.ts's posture for the same status family.
 */
export function intuticApproval(opts: IntuticApprovalOptions = {}): EveApprovalPolicy {
  return async (ctx) => {
    const g = opts.gate ?? activeGate()
    if (g === null) {
      throw new Error(
        'No gate configured: call install(new Gate(...)) from @intutic/gate, or pass ' +
          '{ gate } to intuticApproval(). Refusing to run the tool unguarded.',
      )
    }
    try {
      await g.guard(ctx.toolName, renderEveToolInput(ctx.toolInput))
      return opts.onAllow ?? 'not-applicable'
    } catch (exc) {
      if (exc instanceof IntuticGateRefusal) {
        return { type: 'denied', reason: exc.message }
      }
      throw exc
    }
  }
}

/**
 * The same policy, shaped for a CONNECTION's `approval` field — eve's MCP and
 * OpenAPI connections accept one `approval` gating ALL of that connection's
 * tools (`defineMcpClientConnection`/`defineOpenAPIConnection`, confirmed at
 * `dist/src/public/definitions/connections/{mcp,openapi}.d.ts` — an omitted
 * `approval` means every connection tool executes without approval):
 *
 * ```ts
 * // agent/connections/support.ts
 * import { defineMcpClientConnection } from 'eve/connections'
 * import { intuticConnectionApproval } from '@intutic/gate/eve'
 *
 * export default defineMcpClientConnection({
 *   url: 'https://support.example.com/mcp',
 *   description: 'Support tickets.',
 *   approval: intuticConnectionApproval(),
 * })
 * ```
 *
 * Implemented AS {@link intuticApproval} (one enforcement path, not two) —
 * the separate export exists because the surface differs in one way worth
 * knowing: `ctx.toolName` for a connection tool is the QUALIFIED name
 * (`support__add_internal_note`, connection slug + `__` + remote tool name —
 * eve's own convention, per `docs/patterns/multi-tenant-approvals.md`), and
 * that qualified name is what `Gate.guard()` evaluates and what SOP rules /
 * snapshot `tool:` subjects must match. This adapter deliberately does not
 * strip the prefix: the qualified name is the call's real identity inside
 * this eve app, and un-prefixing would let two connections' same-named remote
 * tools collapse into one rule target.
 */
export function intuticConnectionApproval(opts: IntuticApprovalOptions = {}): EveApprovalPolicy {
  return intuticApproval(opts)
}

// --------------------------------------------------------------------------
// Audit hooks (observe-only)
// --------------------------------------------------------------------------

/** Structural copy of eve's `ApprovalCandidateStreamEvent` — the
 *  `approval.candidate` payload (`dist/src/protocol/message.d.ts`). Note:
 *  no tool name/input fields exist on this event (see module doc). */
export interface EveApprovalCandidateEvent {
  readonly type: 'approval.candidate'
  readonly data: {
    readonly candidateId: string
    readonly outcome: 'pending' | 'rejected' | 'failed' | 'timed-out' | 'stale'
    readonly requestId: string
    readonly responderPrincipalId: string
    readonly reason?: string
    readonly sequence: number
    readonly stepIndex: number
    readonly turnId: string
  }
}

/** Structural copy of eve's `ApprovalSettledStreamEvent` — the terminal
 *  durable settlement for one approval request. */
export interface EveApprovalSettledEvent {
  readonly type: 'approval.settled'
  readonly data: {
    readonly outcome: 'approved' | 'cancelled'
    readonly requestId: string
    readonly responderPrincipalId: string
    readonly sequence: number
    readonly stepIndex: number
    readonly turnId: string
  }
}

/** Structural slice of eve's `HookContext` this adapter reads. The real
 *  context is wider (extends `SessionContext`, `agent.name` required) — the
 *  real type is assignable to this one. */
export interface EveHookContext {
  readonly session: { readonly id: string }
  readonly agent?: { readonly name: string }
}

/** The `{ events }` object {@link intuticAuditHooks} returns — structurally
 *  a valid eve `HookDefinition`, accepted by `defineHook` as-is. */
export interface EveAuditHookDefinition {
  readonly events: {
    readonly 'approval.candidate': (
      event: EveApprovalCandidateEvent,
      ctx: EveHookContext,
    ) => Promise<void>
    readonly 'approval.settled': (
      event: EveApprovalSettledEvent,
      ctx: EveHookContext,
    ) => Promise<void>
  }
}

export interface IntuticAuditHooksOptions {
  /**
   * Fixed control-plane client. When omitted, one client is built per eve
   * session via `GateClient.fromEnv({ harness: 'eve', sessionId })` using the
   * eve session id off the hook context — eve's durable session IS the
   * meaningful attribution unit here, unlike dsh (whose plugin mounts before
   * any session exists and settles for one process-wide id). Passing a
   * client pins every event to THAT client's own session id instead.
   */
  client?: GateClient
}

/**
 * Observe-only audit emitter for eve's human-approval lifecycle, shaped for
 * `agent/hooks/`:
 *
 * ```ts
 * // agent/hooks/intutic-audit.ts
 * import { defineHook } from 'eve/hooks'
 * import { intuticAuditHooks } from '@intutic/gate/eve'
 *
 * export default defineHook(intuticAuditHooks())
 * ```
 *
 * Maps eve's approval stream events onto Intutic's gate event vocabulary
 * (the same `tool_allowed`/`tool_blocked`/`tool_flagged` names `gate.ts`
 * emits, so the dashboard renders both sources on one timeline):
 *
 * - `approval.settled` `outcome: 'approved'` → `tool_allowed` — a human
 *   explicitly approved the parked call.
 * - `approval.settled` `outcome: 'cancelled'` → `tool_blocked` — the request
 *   was settled without approval; the call never ran. This is a HUMAN veto
 *   recorded for audit, not an Intutic-gate refusal (the reason string says
 *   so), and like every `tool_blocked` it creates an incident row.
 * - `approval.candidate` non-`'pending'` outcomes (`rejected`/`failed`/
 *   `timed-out`/`stale`) → `tool_flagged` — a responder's attempt to answer
 *   went somewhere worth an operator's attention. `'pending'` (a candidate
 *   simply being created) is routine lifecycle and deliberately NOT emitted.
 *
 * These hooks are TELEMETRY, not enforcement: eve runs hook handlers after
 * events are durably recorded, and they cannot veto anything (eve's own
 * "observe-only" hook contract). The enforcement surface is
 * {@link intuticApproval}. Handlers never throw — a telemetry failure must
 * not break the run (`GateClient.emit`'s own never-throws contract) — and
 * the emitted events carry {@link EVE_APPROVAL_TOOL_NAME} as the tool name
 * because eve's approval events do not include the real one (see module doc).
 */
export function intuticAuditHooks(opts: IntuticAuditHooksOptions = {}): EveAuditHookDefinition {
  const perSession = new Map<string, GateClient | null>()

  function clientFor(sessionId: string): GateClient | null {
    if (opts.client !== undefined) return opts.client
    let client = perSession.get(sessionId)
    if (client === undefined) {
      try {
        client = GateClient.fromEnv({ harness: 'eve', sessionId })
      } catch {
        // fromEnv only throws on a missing session id, which we always
        // supply — but a telemetry hook must never take the run down over a
        // client it could not build.
        client = null
      }
      perSession.set(sessionId, client)
    }
    return client
  }

  return {
    events: {
      'approval.candidate': async (event, ctx) => {
        if (event.data.outcome === 'pending') return
        const client = clientFor(ctx.session.id)
        if (client === null) return
        const suffix = event.data.reason ? `: ${event.data.reason}` : ''
        await client.emit(
          'tool_flagged',
          EVE_APPROVAL_TOOL_NAME,
          `eve approval candidate ${event.data.outcome} (request ${event.data.requestId}, ` +
            `responder ${event.data.responderPrincipalId})${suffix}`,
          event.data,
        )
      },
      'approval.settled': async (event, ctx) => {
        const client = clientFor(ctx.session.id)
        if (client === null) return
        if (event.data.outcome === 'approved') {
          await client.emit(
            'tool_allowed',
            EVE_APPROVAL_TOOL_NAME,
            `eve approval settled: approved by ${event.data.responderPrincipalId} ` +
              `(request ${event.data.requestId})`,
            event.data,
          )
          return
        }
        await client.emit(
          'tool_blocked',
          EVE_APPROVAL_TOOL_NAME,
          `eve approval settled: cancelled — the parked tool call never ran ` +
            `(request ${event.data.requestId}, responder ${event.data.responderPrincipalId}). ` +
            `Human veto recorded by the observe-only audit hook, not an Intutic gate refusal.`,
          event.data,
        )
      },
    },
  }
}
