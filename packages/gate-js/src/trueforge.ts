/**
 * TrueForge (embedded) adapter: `intuticApprovalResponder()`.
 *
 * `@intutic/gate/trueforge` — Phase 1 of TrueForge support: another team's
 * Node process that imports `@truefoundry/trueforge-core` directly
 * (github.com/truefoundry/trueforge, MIT) and drives its own
 * `SessionHandle`/`TurnHandle` API in-process. Same family idea as
 * `mastra.ts`/`vercel.ts` (wrap the framework's own veto point around this
 * package's `Gate.guard()`), but TrueForge's veto point is shaped
 * differently from either of those, so this module follows `harness.ts`'s
 * `intuticApprovalResponder()` precedent instead — a batch function
 * answering pending approvals — not a single-call `beforeToolCall`/
 * `toolApproval` option.
 *
 * Phase 2 (`HarnessType.TRUEFORGE_SERVER` — TrueForge run as its own
 * standalone/hosted server, e.g. `npx @truefoundry/trueforge`, Docker
 * Compose, or the Helm chart) is explicitly OUT OF SCOPE here. Nobody embeds
 * an Intutic gate into a third-party OSS server process; that deployment
 * mode needs governance running in an external Intutic-operated bridge
 * service — separate, larger work, not attempted in this module.
 *
 * ## Confirmed against the real published package, not assumed
 *
 * `@truefoundry/trueforge-core@0.1.4` (`latest` on npm at the time this was
 * written) was downloaded from the npm registry and its shipped `.d.ts`
 * files read directly — not inferred from docs alone:
 *
 *   - There is NO synchronous, in-process "approval resolver" callback
 *     anywhere in the package. Every shipped `.d.ts` file was grepped for
 *     `approvalResolver`/`onApproval`/`approvalHandler`/`resolveApproval`:
 *     zero matches. `ITurnResourceResolver`
 *     (`dist/agent-session/ITurnResourceResolver.d.ts`) resolves sandboxes,
 *     agent definitions, and tracing per run — it carries no tool-call veto
 *     hook of any kind.
 *   - The ONLY approval mechanism, embedded or not, is the same turn/event
 *     contract TrueForge's standalone server exposes over HTTP: a turn
 *     pauses with a `required_actions` entry of type `tool.approval_required`
 *     (`EventType.TOOL_APPROVAL_REQUIRED`, `dist/agent-session/schemas/
 *     events.d.ts`), naming each pending call only as `{id, source_event_id}`
 *     — no tool name or arguments travel on the event itself. Answering it
 *     means constructing a NEW turn (`SessionHandle.createTurn()`) whose
 *     `input` carries a `user.tool_approval` item:
 *     `{type:'user.tool_approval', thread_id, tool_call_id, approval}`,
 *     where `approval` is `{status:'allow'} | {status:'deny', reason?:
 *     string}` (`ApprovalDecisionSchema`, `dist/core/events/schema.d.ts`) —
 *     confirmed field-for-field, and pinned by this module's own test file
 *     via a structural assignability check against the real exported
 *     `TurnInputItem` (`@truefoundry/trueforge-core/agent-session`) and
 *     `ApprovalDecision` (`@truefoundry/trueforge-core/core`) types.
 *
 * So unlike `mastra.ts`/`vercel.ts`, this adapter cannot BE "the function you
 * pass as a framework option" — embedded TrueForge has no such option. What
 * it can be, and is, is the `harness.ts`-shaped piece: a function that
 * evaluates a batch of pending approval requests through `Gate.guard()` and
 * returns the `user.tool_approval` `TurnInputItem[]` ready to hand to your
 * next `session.createTurn({ input, previous_turn_id })` call.
 *
 * ## What the embedding host still has to do itself
 *
 * Resolving a `{id, source_event_id}` tool-call reference back to the real
 * tool NAME and ARGUMENTS is the host's job, not this adapter's: the host
 * already owns the `TurnHandle`/event stream (`turn.stream()`/
 * `listEvents()`) this package has no reason to depend on, and
 * `source_event_id` points at a `model.message` event whose tool-call wire
 * shape this package deliberately does not import — matching
 * `mastra.ts`/`vercel.ts`'s existing convention of zero runtime dependency
 * on the framework being gated. Build the `TrueforgeApprovalRequest[]` this
 * responder consumes from whatever your own event-resolution loop already
 * extracts, then feed the returned items straight into your next
 * `createTurn()` call.
 *
 * ## GUESSED, clearly marked as such: the exact orchestration wiring
 *
 * The plan that authored this phase asked to pin the exact registration API
 * against `TurnHandle`/`ITurnResourceResolver`; having read both real files,
 * NEITHER carries a registration point for this at all — the orchestration
 * loop (drive `turn.stream()`, detect a `tool.approval_required` required
 * action, resolve each `source_event_id`, call this responder, call
 * `createTurn()` again with the answers) is necessarily HAND-WRITTEN
 * application code in the embedding host, not something a config option
 * turns on. That loop's exact shape — how you persist the paused turn id,
 * how you resolve `source_event_id`, whether you drain `stream()` to
 * completion before or after answering — is a genuine judgment call for the
 * embedding host's own architecture and is NOT prescribed here. See
 * `apps/docs/integrations/trueforge.md` for a worked (illustrative, not
 * load-bearing) example of one way to wire this loop.
 *
 * @module
 */

import { active as activeGate, type Gate } from './gate.js'
import { IntuticGateRefusal } from './errors.js'

/**
 * One pending `tool.approval_required` request, already resolved to a real
 * tool name and arguments by the embedding host — see the module doc's
 * "What the embedding host still has to do itself".
 */
export interface TrueforgeApprovalRequest {
  /** TrueForge's own thread id for this call — carried through unchanged
   *  onto the `user.tool_approval` item this responder produces. */
  readonly threadId: string
  /** The pending tool call's id (`ToolCallRef.id`) — becomes `tool_call_id`
   *  on the produced item. */
  readonly toolCallId: string
  /** The tool name `Gate.guard()` evaluates. */
  readonly toolName: string
  /** The tool's arguments, resolved from the `model.message` event the
   *  pending call's `source_event_id` points at. */
  readonly input: unknown
}

/**
 * Structural copy of `@truefoundry/trueforge-core`'s `ApprovalDecision`
 * (`ApprovalDecisionSchema`, `core/events/schema.ts`) — this package does
 * not depend on `@truefoundry/trueforge-core` at runtime, so the shape is
 * declared here rather than imported. Confirmed field-for-field against
 * `@truefoundry/trueforge-core@0.1.4`'s shipped `dist/core/events/schema.d.ts`
 * (see module doc).
 */
export type TrueforgeApprovalDecision = { status: 'allow' } | { status: 'deny'; reason?: string }

/**
 * Structural copy of the `user.tool_approval` member of
 * `@truefoundry/trueforge-core`'s `TurnInputItem` union
 * (`UserToolApprovalMessageSchema`, `agent-session/schemas/events.ts`) — the
 * shape `SessionHandle.createTurn({ input })` expects for answering a
 * pending approval. Confirmed field-for-field against the same install.
 */
export interface TrueforgeUserToolApprovalItem {
  type: 'user.tool_approval'
  thread_id: string
  tool_call_id: string
  approval: TrueforgeApprovalDecision
}

export interface IntuticApprovalResponderOptions {
  /** Overrides the process-wide installed gate (`install(new Gate(...))`). */
  gate?: Gate
}

/**
 * Render a pending request's `input` as the `tool_input` object
 * {@link Gate.guard} evaluates. Mirrors `harness.ts`'s/`workflow.ts`'s own
 * coercion: a non-object input (a bare string/number/array — TrueForge's own
 * `model.message` tool-call arguments are typically already an object, but
 * this adapter does not import that wire format to assume so) falls back to
 * `{ args: [...] }` so the gate always has something to evaluate.
 */
export function renderTrueforgeToolInput(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  return { args: [input] }
}

/**
 * Build an approval responder: a function that evaluates each pending
 * TrueForge tool-approval request via `Gate.guard()` and produces the
 * `user.tool_approval` input items for your next `createTurn()` call:
 *
 * ```ts
 * import { Gate, install } from '@intutic/gate'
 * import { intuticApprovalResponder } from '@intutic/gate/trueforge'
 *
 * install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))
 *
 * const respond = intuticApprovalResponder()
 *
 * // ...drive turn.stream() until it pauses on a tool.approval_required
 * // required_action; resolve each {id, source_event_id} back to a real
 * // tool name + arguments (see the module doc), then:
 * const input = await respond(pendingRequests)
 * const nextTurn = await session.createTurn({
 *   turn_id: newTurnId(),
 *   input,
 *   previous_turn_id: pausedTurn.id,
 *   signal,
 *   resolver,
 * })
 * ```
 *
 * Decision mapping, per request:
 *
 *   - gate allows              -> `{ status: 'allow' }`
 *   - `IntuticGateRefusal`     -> `{ status: 'deny', reason }` — the
 *     `[Intutic Governance] BLOCKED: ...` message
 *   - any OTHER throw          -> `{ status: 'deny', reason: '... gate
 *     crashed ...' }` — fail CLOSED, same posture as `harness.ts`'s
 *     responder: this function's output is a decision list fed into a
 *     resumed turn, and a deliverable, auditable deny is better than an
 *     escaped throw that leaves the caller with nothing to resume with.
 *
 * Requires a `Gate` — either passed via `{ gate }`, or installed process-wide
 * with `install(new Gate(...))`. A call with neither throws before
 * evaluating anything, refusing to answer approvals unguarded.
 */
export function intuticApprovalResponder(
  opts: IntuticApprovalResponderOptions = {},
): (requests: readonly TrueforgeApprovalRequest[]) => Promise<TrueforgeUserToolApprovalItem[]> {
  return async (requests) => {
    const g = opts.gate ?? activeGate()
    if (g === null) {
      throw new Error(
        'No gate configured: call install(new Gate(...)) from @intutic/gate, or pass ' +
          '{ gate } to intuticApprovalResponder(). Refusing to answer tool approvals unguarded.',
      )
    }

    const items: TrueforgeUserToolApprovalItem[] = []
    for (const req of requests) {
      let approval: TrueforgeApprovalDecision
      try {
        await g.guard(req.toolName, renderTrueforgeToolInput(req.input))
        approval = { status: 'allow' }
      } catch (exc) {
        if (exc instanceof IntuticGateRefusal) {
          approval = { status: 'deny', reason: exc.message }
        } else {
          const detail = exc instanceof Error ? exc.message : String(exc)
          approval = {
            status: 'deny',
            reason:
              `[Intutic Governance] BLOCKED: gate crashed (${detail}) — failing closed rather ` +
              'than approving an unevaluated call.',
          }
        }
      }
      items.push({
        type: 'user.tool_approval',
        thread_id: req.threadId,
        tool_call_id: req.toolCallId,
        approval,
      })
    }
    return items
  }
}
